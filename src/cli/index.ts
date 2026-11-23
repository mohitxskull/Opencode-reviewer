#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  countFindingsByOrigin,
  PEER_VERSION,
  type ReviewProfile,
  ReviewProfileSchema,
  type RunManifest,
  RunManifestSchema,
  type Severity,
  SeveritySchema,
} from "../domain/models.ts";
import { GitHubClient, parsePrTarget, resolveGitHubToken } from "../github/client.ts";
import { type OptionalTool, runAnalyzeStage } from "../pipeline/analyze.ts";
import { runCheckGate } from "../pipeline/check.ts";
import { runFinalizeStage } from "../pipeline/finalize.ts";
import { runPublishStage } from "../pipeline/publish.ts";
import { formatTerminalReport } from "../render/terminal.ts";
import { loadJsonIfExists } from "../workspace/artifacts.ts";
import { AuditLogger } from "../workspace/audit-log.ts";
import { computePeerConfigHash, loadPeerConfig } from "../workspace/config.ts";
import {
  CheckpointStore,
  detectRepoOwnerAndName,
  ensureCleanWorkingTree,
  ensureCommitFetched,
  resolveGitTopLevel,
  resolvePeerCommitDir,
  restoreInterruptedSession,
} from "../workspace/git.ts";
import { LearningStore } from "../workspace/learnings.ts";
import { runDoctorCommand } from "./doctor.ts";
import { runInitCommand } from "./init.ts";
import { runLearnCommand } from "./learn.ts";
import { runNextCommand } from "./next.ts";
import { runPromptCommand } from "./prompt.ts";

export interface CliDependencies {
  readonly githubClient?: GitHubClient;
  readonly promptSelectPr?: (
    prs: ReadonlyArray<{ number: number; title: string }>,
  ) => Promise<number>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

type CliCommand = "analyze" | "finalize" | "publish";

const OPTIONAL_TOOLS: readonly OptionalTool[] = ["deny", "geiger", "semver", "coverage", "miri"];
const OPTIONAL_TOOL_SET = new Set<string>(OPTIONAL_TOOLS);
const COMMANDS = new Set<CliCommand>(["analyze", "finalize", "publish"]);

const HELP_TEXT = `peer — Agent-Agnostic Rust PR Ground-Truth & Verification Engine

Commands:
  peer check [--base <ref>]        Local deterministic gate (0 GitHub token, 0 LLM; supports --sarif & baseline)
  peer analyze  [PR]               Stage 1: Deterministic Rust analysis -> .peer/<pr>/<sha>/01-analyze/ (default)
  peer finalize [PR] --from <file> Stage 2/3: Judge merge + cargo check suggestion verifier -> review.md
  peer finalize [PR] --verdicts <f> Stage 3: Apply skeptic verdicts deterministically -> 03-verify/
  peer publish  [PR]               Stage 4: Upload latest saved stage (01, 02, or 03) to GitHub PR
  peer next     [PR]               Inspect .peer/<pr>/<sha>/ artifacts and print current stage + next command
  peer doctor                      Check local Rust toolchain & analyzer readiness
  peer prompt <name|list>          Print embedded Rust lens prompt (walkthrough|soundness|idioms|skeptic|format)
  peer restore                     Restore original branch after an interrupted checkout (e.g. SIGKILL)
  peer init [--fresh] [--install] [--baseline] [--ci] [--tools <list|all>]
                                   Smart repo onboarding: tailored peer.toml, zero-false-positive deny.toml, optional tool install & CI
  peer learn add "<rule>" [--scope "<glob>"] [--repo <path>]
  peer learn list [--repo <path>]
  peer learn remove <id> [--repo <path>]

Options:
  --repo <path>              Target local Rust git repository (default: cwd)
  --profile <profile>        Strictness profile: quiet | chill | assertive (default: assertive)
  --tools <list|all>         Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all
  --base <ref>               For 'check': base git ref to diff against (default: main -> master -> HEAD~1)
  --all-files                For 'check': scan entire repository (diff against empty tree)
  --staged                   For 'check': scan staged changes only (pre-commit mode)
  --sarif <path>             For 'check': write SARIF 2.1.0 report to file
  --update-baseline          For 'check': record current findings into .peer/baseline.json
  --from <file|dir>          For 'finalize': agent review file or directory of cohort review .md files
  --verdicts <file|dir>      For 'finalize': skeptic verdicts file or directory to filter Stage 2 findings
  --exclude-tools <list|all> For 'finalize': exclude tool findings (e.g. coverage,semver,geiger,deny,miri,ast or all)
  --min-severity <level>     For 'finalize': minimum severity to keep (Critical|Major|Minor|Trivial|Info)
  --stage <review|verify>    For 'finalize': target stage folder (default: review)
  --strict                   For 'finalize': fail if any finding blocks are malformed or coerced
  --no-checkout              Run in-place without switching git branches (for CI already on PR head)
  --fresh                    Ignore saved stage artifacts & checkpoint; re-run from scratch
  --submit                   For 'publish': submit as COMMENT instead of PENDING draft
  --scope <glob>             Optional path glob for 'peer learn add' (e.g. "src/oms/**")
  --json                     Emit machine-readable JSON output to stdout (agent-first mode)
  -q, --quiet                Emit single-line compact JSON result to stdout (suppresses progress logs)
  -v, --verbose              Print full finding bodies and code blocks in terminal summary
  -h, --help                 Show this help message

Exit Codes:
  0  Success (or clean gate for 'peer check' / all tools ready for 'peer doctor')
  1  Blocking findings detected ('peer check') or required toolchain missing ('peer doctor')
  2  Usage, configuration, git, network, timeout, strict-parse, or missing-cohort error
`;

export function parseToolsOption(raw?: string): Set<OptionalTool> {
  const selected = new Set<OptionalTool>();
  if (!raw || raw.trim().length === 0) {
    return selected;
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  for (const part of parts) {
    if (part === "all") {
      for (const t of OPTIONAL_TOOLS) {
        selected.add(t);
      }
      continue;
    }
    if (!OPTIONAL_TOOL_SET.has(part)) {
      throw new Error(
        `Unknown tool "${part}" in --tools. Valid values: ${OPTIONAL_TOOLS.join(", ")}, all`,
      );
    }
    selected.add(part as OptionalTool);
  }
  return selected;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, i) => val === sb[i]);
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((text: string) => console.log(text));
  const writeErr = deps.stderr ?? ((text: string) => console.error(text));

  try {
    // Support `cargo peer <cmd>` invocation where Cargo prepends "peer" as the first arg
    const rawArgs = argv[0] === "peer" ? argv.slice(1) : [...argv];
    const parsed = parseArgs({
      args: [...rawArgs],
      options: {
        repo: { type: "string" },
        profile: { type: "string" },
        tools: { type: "string" },
        base: { type: "string" },
        "all-files": { type: "boolean", default: false },
        staged: { type: "boolean", default: false },
        sarif: { type: "string" },
        "update-baseline": { type: "boolean", default: false },
        from: { type: "string" },
        verdicts: { type: "string" },
        "exclude-tools": { type: "string" },
        "min-severity": { type: "string" },
        stage: { type: "string" },
        strict: { type: "boolean", default: false },
        "no-checkout": { type: "boolean", default: false },
        fresh: { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        baseline: { type: "boolean", default: false },
        ci: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
        scope: { type: "string" },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", short: "q", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });

    if (parsed.values.help) {
      writeOut(HELP_TEXT);
      return 0;
    }

    const isJson = parsed.values.json ?? false;
    const isQuiet = parsed.values.quiet ?? false;

    if (parsed.positionals[0] === "doctor") {
      return await runDoctorCommand(writeOut, { json: isJson, quiet: isQuiet });
    }

    if (parsed.positionals[0] === "prompt") {
      return runPromptCommand(parsed.positionals.slice(1), writeOut, writeErr);
    }

    const repoRoot = resolveGitTopLevel(resolve(parsed.values.repo ?? process.cwd()));
    const learningStore = new LearningStore(repoRoot);

    if (parsed.positionals[0] === "next") {
      return await runNextCommand(repoRoot, parsed.positionals[1], writeOut, {
        json: isJson,
        quiet: isQuiet,
      });
    }

    if (parsed.positionals[0] === "check") {
      return await runCheckGate({
        repoRoot,
        baseRef: parsed.values.base,
        profileOverride: parsed.values.profile
          ? ReviewProfileSchema.parse(parsed.values.profile)
          : undefined,
        cliTools: parseToolsOption(parsed.values.tools),
        sarifPath: parsed.values.sarif,
        updateBaseline: parsed.values["update-baseline"] ?? false,
        strict: parsed.values.strict ?? false,
        allFiles: parsed.values["all-files"] ?? false,
        staged: parsed.values.staged ?? false,
        json: isJson,
        quiet: isQuiet,
        writeOut,
        writeErr,
      });
    }

    if (parsed.positionals[0] === "restore") {
      const res = await restoreInterruptedSession(repoRoot);
      if (isJson) {
        writeOut(JSON.stringify(res, null, 2));
        return 0;
      }
      if (!isQuiet) {
        if (res.restored) {
          writeOut(`Restored repository HEAD to \`${res.originalRef}\`.`);
        } else {
          writeOut("No interrupted peer checkout session found.");
        }
      }
      return 0;
    }

    if (parsed.positionals[0] === "init") {
      return await runInitCommand(
        repoRoot,
        {
          fresh: parsed.values.fresh ?? false,
          install: parsed.values.install ?? false,
          baseline: parsed.values.baseline ?? false,
          ci: parsed.values.ci ?? false,
          tools: parseToolsOption(parsed.values.tools),
          json: isJson,
          quiet: isQuiet,
        },
        writeOut,
        writeErr,
      );
    }

    if (parsed.positionals[0] === "learn") {
      return await runLearnCommand(
        parsed.positionals.slice(1),
        parsed.values.scope,
        learningStore,
        writeOut,
        writeErr,
        { json: isJson, quiet: isQuiet },
      );
    }

    const positionals = [...parsed.positionals];
    let command: CliCommand = "analyze";
    if (positionals[0] && COMMANDS.has(positionals[0] as CliCommand)) {
      command = positionals.shift() as CliCommand;
    }

    const profile: ReviewProfile = ReviewProfileSchema.parse(parsed.values.profile ?? "assertive");
    const fresh = parsed.values.fresh ?? false;
    const strict = parsed.values.strict ?? false;
    const noCheckout = parsed.values["no-checkout"] ?? false;
    const submitReview = parsed.values.submit ?? false;
    const enabledTools = parseToolsOption(parsed.values.tools);

    if (submitReview && command !== "publish") {
      writeErr("Error: --submit is only valid with `peer publish`.");
      return 2;
    }

    const finalizeStage = (parsed.values.stage ?? "review") as "review" | "verify";
    if (command === "finalize") {
      if (!parsed.values.from && !parsed.values.verdicts) {
        writeErr(
          "Error: `peer finalize` requires `--from <file|dir>` or `--verdicts <file>` with the agent's review output.",
        );
        return 2;
      }
      if (finalizeStage !== "review" && finalizeStage !== "verify") {
        writeErr("Error: --stage must be `review` or `verify`.");
        return 2;
      }
    }

    const isVerdictsOnlyFinalize = command === "finalize" && Boolean(parsed.values.verdicts);
    if (command !== "publish" && !noCheckout && !isVerdictsOnlyFinalize) {
      await ensureCleanWorkingTree(repoRoot);
    }

    const rawPrTarget = positionals[0];
    let defaultOwner = "unknown";
    let defaultRepo = "unknown";
    try {
      const detected = detectRepoOwnerAndName(repoRoot);
      defaultOwner = detected.owner;
      defaultRepo = detected.repo;
    } catch {
      // Allow explicit full PR URL to supply owner/repo if origin remote isn't configured
    }

    let owner = defaultOwner;
    let repo = defaultRepo;
    let prNumber = 0;

    if (rawPrTarget) {
      const target = parsePrTarget(rawPrTarget, defaultOwner, defaultRepo);
      owner = target.owner;
      repo = target.repo;
      prNumber = target.prNumber;
    }

    if (owner === "unknown" || repo === "unknown") {
      writeErr(
        "Unable to determine GitHub repository owner/name from 'origin' remote. Configure a GitHub 'origin' remote or pass a full GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>).",
      );
      return 2;
    }

    const githubClient =
      deps.githubClient ?? new GitHubClient({ token: await resolveGitHubToken() });

    if (!rawPrTarget) {
      const openPrs = await githubClient.listOpenPrs(owner, repo);
      if (openPrs.length === 0) {
        writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
        return 2;
      }
      if (deps.promptSelectPr) {
        prNumber = await deps.promptSelectPr(openPrs);
      } else {
        const firstPr = openPrs[0];
        if (!firstPr) {
          writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
          return 2;
        }
        prNumber = firstPr.number;
      }
    }

    const pr = await githubClient.getPullRequest(owner, repo, prNumber);
    // Ensure baseSha is present locally so `git show <baseSha>:...` never silently falls back on stale clones
    ensureCommitFetched(repoRoot, pr.baseSha, pr.baseRefName);
    // Load peer.toml strictly from pr.baseSha (never untrusted pr.headSha)
    const peerConfig = await loadPeerConfig(repoRoot, pr.baseSha);
    const configHash = computePeerConfigHash(peerConfig);
    const effectiveProfile: ReviewProfile = parsed.values.profile ? profile : peerConfig.profile;
    const effectiveSubmit = submitReview || peerConfig.publish.mode === "comment";
    const effectiveTools = new Set<OptionalTool>(enabledTools);
    for (const toolName of OPTIONAL_TOOLS) {
      if (peerConfig.tools[toolName]) {
        effectiveTools.add(toolName);
      }
    }
    const effectiveToolsList = Array.from(effectiveTools).sort();

    const checkpointStore = new CheckpointStore(repoRoot);
    const runStartMs = Date.now();
    const commitDir = resolvePeerCommitDir(repoRoot, pr.number, pr.headSha);
    const existingManifest = !fresh
      ? await loadJsonIfExists<RunManifest>(join(commitDir, "run.json"), RunManifestSchema)
      : null;

    if (command === "publish") {
      return await runPublishStage({
        repoRoot,
        commitDir,
        owner,
        repo,
        pr,
        submitReview: effectiveSubmit,
        modelLabel: "external-agent",
        enabledToolsList: effectiveToolsList,
        runStartMs,
        existingManifest,
        githubClient,
        checkpointStore,
        json: isJson,
        quiet: isQuiet,
        writeOut,
        writeErr,
      });
    }

    if (
      command === "analyze" &&
      !fresh &&
      existingManifest &&
      existingManifest.status === "completed" &&
      existingManifest.headSha === pr.headSha &&
      existingManifest.profile === effectiveProfile &&
      existingManifest.peerVersion === PEER_VERSION &&
      existingManifest.configHash === configHash &&
      sameStringArray(existingManifest.enabledTools, effectiveToolsList) &&
      existingManifest.completedStages.includes("analyze")
    ) {
      if (isJson || isQuiet) {
        writeOut(
          JSON.stringify(
            {
              status: "cached",
              stage: "analyze",
              prNumber: pr.number,
              headSha: pr.headSha,
              baseSha: pr.baseSha,
              profile: effectiveProfile,
              enabledTools: effectiveToolsList,
              toolOutcomes: existingManifest.toolOutcomes,
              counts: {
                inline: existingManifest.inlineFindingsCount,
                outsideDiff: existingManifest.outsideDiffFindingsCount,
                nitpicks: existingManifest.nitpickFindingsCount,
                clippy: existingManifest.clippyCount,
                securityAdvisories: existingManifest.securityAdvisoriesCount,
              },
              artifacts: {
                commitDir: resolve(commitDir),
                promptContextMd: resolve(commitDir, "01-analyze", "prompt-context.md"),
                cohortsIndexJson: resolve(commitDir, "01-analyze", "cohorts", "index.json"),
                reportMd: resolve(commitDir, "01-analyze", "report.md"),
              },
              nextCommand: `peer finalize ${pr.number} --from ${commitDir}/reviews --strict`,
            },
            null,
            isQuiet ? undefined : 2,
          ),
        );
        return 0;
      }
      writeOut(
        `Already analyzed PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (profile=${effectiveProfile}, tools=${effectiveToolsList.join(",") || "core"}).\nContext: file://${resolve(commitDir, "01-analyze", "prompt-context.md")}\nReport:  file://${resolve(commitDir, "01-analyze", "report.md")}\nPass --fresh to force a re-run.`,
      );
      return 0;
    }

    const auditLogger = new AuditLogger({
      repoRoot,
      prNumber: pr.number,
      headSha: pr.headSha,
      onProgress: isJson || isQuiet ? undefined : (line) => writeOut(line),
    });

    if (command === "analyze") {
      await auditLogger.logEvent(
        "run.started",
        `▶ Analyzing PR #${pr.number} (${owner}/${repo}: "${pr.title}") head=${pr.headSha.slice(0, 7)} base=${pr.baseSha.slice(0, 7)}`,
        {
          owner,
          repo,
          prNumber: pr.number,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          enabledTools: effectiveToolsList,
          configHash,
          fresh,
        },
      );

      const analyzeOut = await runAnalyzeStage({
        repoRoot,
        commitDir,
        owner,
        repo,
        pr,
        profile: effectiveProfile,
        fresh,
        noCheckout,
        enabledTools: effectiveTools,
        enabledToolsList: effectiveToolsList,
        explicitTools: effectiveTools,
        peerConfig,
        configHash,
        runStartMs,
        githubClient,
        checkpointStore,
        auditLogger,
      });

      if (isJson || isQuiet) {
        const allActionable = [
          ...analyzeOut.analyzeBundle.findings,
          ...(analyzeOut.analyzeBundle.outsideDiffFindings ?? []),
        ];
        const countsBySeverity = {
          Critical: allActionable.filter((f) => f.severity === "Critical").length,
          Major: allActionable.filter((f) => f.severity === "Major").length,
          Minor: allActionable.filter((f) => f.severity === "Minor").length,
          Trivial: allActionable.filter((f) => f.severity === "Trivial").length,
          Info: allActionable.filter((f) => f.severity === "Info").length,
        };
        writeOut(
          JSON.stringify(
            {
              status: "completed",
              stage: "analyze",
              prNumber: pr.number,
              headSha: pr.headSha,
              baseSha: pr.baseSha,
              diffBaseSha: analyzeOut.analyzeBundle.diffBaseSha,
              isIncremental: analyzeOut.analyzeBundle.isIncremental,
              profile: effectiveProfile,
              enabledTools: effectiveToolsList,
              toolOutcomes: analyzeOut.toolOutcomes,
              counts: {
                totalActionable: allActionable.length,
                inline: analyzeOut.analyzeBundle.findings.length,
                outsideDiff: analyzeOut.analyzeBundle.outsideDiffFindings?.length ?? 0,
                nitpicks: analyzeOut.analyzeBundle.nitpickFindings?.length ?? 0,
                clippy: analyzeOut.analyzeBundle.clippyDiagnostics.length,
                securityAdvisories: analyzeOut.analyzeBundle.securityAdvisories?.length ?? 0,
                byOrigin: countFindingsByOrigin(allActionable),
              },
              countsBySeverity,
              artifacts: {
                commitDir: resolve(commitDir),
                promptContextMd: resolve(commitDir, "01-analyze", "prompt-context.md"),
                cohortsIndexJson: resolve(commitDir, "01-analyze", "cohorts", "index.json"),
                reportMd: resolve(commitDir, "01-analyze", "report.md"),
                bundleJson: resolve(commitDir, "01-analyze", "bundle.json"),
              },
              nextCommand: `peer finalize ${pr.number} --from ${commitDir}/reviews --strict`,
            },
            null,
            isQuiet ? undefined : 2,
          ),
        );
        return 0;
      }

      writeOut(
        formatTerminalReport(analyzeOut.analyzeBundle, repoRoot, join(commitDir, "01-analyze"), {
          verbose: parsed.values.verbose ?? false,
          enabledTools: effectiveToolsList,
          nextStepHint: `Run \`peer next ${pr.number}\` or fan out cohort reviews from ${join(commitDir, "01-analyze", "cohorts", "index.json")}`,
        }),
      );
      writeOut(
        `Agent Prompt Context: file://${resolve(commitDir, "01-analyze", "prompt-context.md")}`,
      );
      return 0;
    }

    // command === "finalize"
    const fromPath = parsed.values.from
      ? parsed.values.from
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(p))
          .join(",")
      : undefined;
    const verdictsPath = parsed.values.verdicts
      ? parsed.values.verdicts
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(p))
          .join(",")
      : undefined;
    const excludeTools = parsed.values["exclude-tools"]
      ? new Set(
          parsed.values["exclude-tools"]
            .split(",")
            .map((p) => p.trim().toLowerCase())
            .filter(Boolean),
        )
      : undefined;
    const minSeverity: Severity | undefined = parsed.values["min-severity"]
      ? SeveritySchema.parse(parsed.values["min-severity"])
      : undefined;
    const result = await runFinalizeStage({
      repoRoot,
      commitDir,
      fromPath,
      verdictsPath,
      stage: verdictsPath ? "verify" : finalizeStage,
      strict,
      noCheckout,
      profile: effectiveProfile,
      excludeTools,
      minSeverity,
      configHash,
      runStartMs,
      auditLogger,
    });

    for (const warning of result.warnings) {
      writeErr(`Warning: ${warning}`);
    }

    const stageFolder = verdictsPath || finalizeStage === "verify" ? "03-verify" : "02-review";

    if (isJson || isQuiet) {
      const allActionable = [
        ...result.bundle.findings,
        ...(result.bundle.outsideDiffFindings ?? []),
      ];
      const verifiedSuggestions = allActionable.filter(
        (f) => f.suggestion !== null && f.suggestionVerified,
      ).length;
      const unverifiedSuggestions = allActionable.filter(
        (f) => f.suggestion !== null && !f.suggestionVerified,
      ).length;
      const countsBySeverity = {
        Critical: allActionable.filter((f) => f.severity === "Critical").length,
        Major: allActionable.filter((f) => f.severity === "Major").length,
        Minor: allActionable.filter((f) => f.severity === "Minor").length,
        Trivial: allActionable.filter((f) => f.severity === "Trivial").length,
        Info: allActionable.filter((f) => f.severity === "Info").length,
      };
      writeOut(
        JSON.stringify(
          {
            status: (result.bundle.failedCohorts?.length ?? 0) > 0 ? "partial" : "completed",
            stage: stageFolder === "03-verify" ? "verify" : "review",
            prNumber: pr.number,
            headSha: pr.headSha,
            counts: {
              totalActionable: allActionable.length,
              inline: result.bundle.findings.length,
              outsideDiff: result.bundle.outsideDiffFindings?.length ?? 0,
              nitpicks: result.bundle.nitpickFindings?.length ?? 0,
              verifiedSuggestions,
              unverifiedSuggestions,
              byOrigin: countFindingsByOrigin(allActionable),
            },
            countsBySeverity,
            ...(result.cohortCoverage ? { cohortCoverage: result.cohortCoverage } : {}),
            ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
            ...(result.malformedBlocks && result.malformedBlocks.length > 0
              ? { malformedBlocks: result.malformedBlocks }
              : {}),
            warnings: result.warnings,
            artifacts: {
              stageReportMd: resolve(commitDir, stageFolder, "report.md"),
              reviewMd: resolve(commitDir, "review.md"),
              todoMd: resolve(commitDir, "todo.md"),
              todoJson: resolve(commitDir, "todo.json"),
              bundleJson: resolve(commitDir, stageFolder, "bundle.json"),
              ...(stageFolder === "02-review"
                ? { skepticIndexJson: resolve(commitDir, "02-review", "skeptic", "index.json") }
                : { skepticJson: resolve(commitDir, "03-verify", "skeptic.json") }),
            },
            nextCommand:
              stageFolder === "02-review"
                ? `peer finalize ${pr.number} --verdicts ${commitDir}/verdicts.md --strict`
                : `peer publish ${pr.number}`,
          },
          null,
          isQuiet ? undefined : 2,
        ),
      );
      return 0;
    }

    const nextHint =
      stageFolder === "02-review"
        ? `Skeptic packets ready at file://${resolve(commitDir, "02-review", "skeptic", "index.json")} — or run \`peer next ${pr.number}\``
        : `Ready to publish (\`peer publish ${pr.number}\`) or hand off \`todo.md\` / \`todo.json\``;
    writeOut(
      formatTerminalReport(result.bundle, repoRoot, join(commitDir, stageFolder), {
        verbose: parsed.values.verbose ?? false,
        verdictSummary: result.verdictSummary,
        nextStepHint: nextHint,
      }),
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(`Error: ${msg}`);
    if (argv.includes("--json") || argv.includes("--quiet") || argv.includes("-q")) {
      const isQuietErr = argv.includes("--quiet") || argv.includes("-q");
      const errorCode =
        msg.includes("Missing ") && msg.includes("expected cohort")
          ? "MISSING_COHORTS"
          : msg.includes("Strict mode failed") || msg.includes("malformed")
            ? "MALFORMED_FINDINGS"
            : msg.includes("Working tree has uncommitted")
              ? "DIRTY_WORKTREE"
              : msg.includes("timed out")
                ? "ANALYZER_TIMED_OUT"
                : msg.includes("exited with code")
                  ? "ANALYZER_FAILED"
                  : "RUNTIME_ERROR";
      writeOut(
        JSON.stringify(
          {
            status: "error",
            exitCode: 2,
            errorCode,
            message: msg,
          },
          null,
          isQuietErr ? undefined : 2,
        ),
      );
    }
    return 2;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
