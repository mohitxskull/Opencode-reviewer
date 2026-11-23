#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  PEER_VERSION,
  type ReviewProfile,
  ReviewProfileSchema,
  type RunManifest,
  RunManifestSchema,
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
  peer doctor                      Check local Rust toolchain & analyzer readiness
  peer prompt <name|list>          Print embedded Rust lens prompt (walkthrough|soundness|idioms|skeptic|format)
  peer restore                     Restore original branch after an interrupted checkout (e.g. SIGKILL)
  peer init [--fresh]              Scaffold a peer.toml repository configuration file
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
  --verdicts <file>          For 'finalize': skeptic verdicts file to filter Stage 2 findings
  --stage <review|verify>    For 'finalize': target stage folder (default: review)
  --strict                   For 'finalize': fail if any finding blocks are malformed or coerced
  --no-checkout              Run in-place without switching git branches (for CI already on PR head)
  --fresh                    Ignore saved stage artifacts & checkpoint; re-run from scratch
  --submit                   For 'publish': submit as COMMENT instead of PENDING draft
  --scope <glob>             Optional path glob for 'peer learn add' (e.g. "src/oms/**")
  -h, --help                 Show this help message
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
        stage: { type: "string" },
        strict: { type: "boolean", default: false },
        "no-checkout": { type: "boolean", default: false },
        fresh: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
        scope: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });

    if (parsed.values.help) {
      writeOut(HELP_TEXT);
      return 0;
    }

    if (parsed.positionals[0] === "doctor") {
      return await runDoctorCommand(writeOut);
    }

    if (parsed.positionals[0] === "prompt") {
      return runPromptCommand(parsed.positionals.slice(1), writeOut, writeErr);
    }

    const repoRoot = resolveGitTopLevel(resolve(parsed.values.repo ?? process.cwd()));
    const learningStore = new LearningStore(repoRoot);

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
        writeOut,
        writeErr,
      });
    }

    if (parsed.positionals[0] === "restore") {
      const res = await restoreInterruptedSession(repoRoot);
      if (res.restored) {
        writeOut(`Restored repository HEAD to \`${res.originalRef}\`.`);
      } else {
        writeOut("No interrupted peer checkout session found.");
      }
      return 0;
    }

    if (parsed.positionals[0] === "init") {
      return await runInitCommand(
        repoRoot,
        { fresh: parsed.values.fresh ?? false },
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
      return 1;
    }

    const githubClient =
      deps.githubClient ?? new GitHubClient({ token: await resolveGitHubToken() });

    if (!rawPrTarget) {
      const openPrs = await githubClient.listOpenPrs(owner, repo);
      if (openPrs.length === 0) {
        writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
        return 1;
      }
      if (deps.promptSelectPr) {
        prNumber = await deps.promptSelectPr(openPrs);
      } else {
        const firstPr = openPrs[0];
        if (!firstPr) {
          writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
          return 1;
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
      writeOut(
        `Already analyzed PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (profile=${effectiveProfile}, tools=${effectiveToolsList.join(",") || "core"}).\nContext: file://${resolve(commitDir, "01-analyze", "prompt-context.md")}\nReport:  file://${resolve(commitDir, "01-analyze", "report.md")}\nPass --fresh to force a re-run.`,
      );
      return 0;
    }

    const auditLogger = new AuditLogger({
      repoRoot,
      prNumber: pr.number,
      headSha: pr.headSha,
      onProgress: (line) => writeOut(line),
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

      writeOut(
        formatTerminalReport(analyzeOut.analyzeBundle, repoRoot, join(commitDir, "01-analyze")),
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
    const verdictsPath = parsed.values.verdicts ? resolve(parsed.values.verdicts) : undefined;
    const result = await runFinalizeStage({
      repoRoot,
      commitDir,
      fromPath,
      verdictsPath,
      stage: verdictsPath ? "verify" : finalizeStage,
      strict,
      noCheckout,
      profile: effectiveProfile,
      configHash,
      runStartMs,
      auditLogger,
    });

    for (const warning of result.warnings) {
      writeErr(`Warning: ${warning}`);
    }

    const stageFolder = verdictsPath || finalizeStage === "verify" ? "03-verify" : "02-review";
    writeOut(formatTerminalReport(result.bundle, repoRoot, join(commitDir, stageFolder)));
    return 0;
  } catch (err) {
    writeErr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
