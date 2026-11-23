#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { AuditLogger } from "./audit.ts";
import { filterCodeOnlyDiffMap, parseUnifiedDiff } from "./diff.ts";
import {
  CheckpointStore,
  detectRepoOwnerAndName,
  ensureCleanWorkingTree,
  resolveGitTopLevel,
  resolvePeerCommitDir,
  runGitSync,
  tryGitRawSync,
  withInPlaceCheckout,
} from "./git.ts";
import {
  GitHubClient,
  type InlineReviewCommentInput,
  parsePrTarget,
  resolveGitHubToken,
} from "./github.ts";
import { buildRustSymbolGraph, type RustSymbolGraph } from "./graph.ts";
import { advisoriesToFindings, clippyToFindings, partitionAndFilterFindings } from "./judge.ts";
import { LearningStore } from "./learnings.ts";
import { type MultiLensRunResult, OpenCodeMultiLensOrchestrator } from "./lenses.ts";
import {
  type AnalyzeStageContext,
  AnalyzeStageContextSchema,
  type ConsideredAndRejectedItem,
  type DeletionProposedItem,
  type Finding,
  type PipelineStage,
  type ReviewBundle,
  ReviewBundleSchema,
  type ReviewProfile,
  ReviewProfileSchema,
  type RunManifest,
  RunManifestSchema,
} from "./models.ts";
import { parseModelSpec } from "./opencode/client.ts";
import type { ReviewContext } from "./prompts/context.ts";
import {
  renderInlineFindingComment,
  renderPrReviewSummaryBody,
  renderWalkthroughComment,
  writeAnalyzeStageArtifacts,
  writePublishStageArtifacts,
  writeReviewStageArtifacts,
  writeVerifyStageArtifacts,
} from "./render/markdown.ts";
import { formatTerminalReport } from "./render/terminal.ts";
import {
  collectClippyDiagnostics,
  collectCrateGraph,
  collectRustToolchainBaseline,
  resolveFileArchitecturalLayer,
} from "./rust.ts";
import { type CargoLockDiff, collectCargoLockDiff, collectSecurityAdvisories } from "./security.ts";
import {
  collectCargoLlvmCovReport,
  type CoverageReport,
  coverageReportToFindings,
} from "./tools/coverage.ts";
import { collectCargoDenyDiagnostics, denyDiagnosticsToFindings } from "./tools/deny.ts";
import {
  collectCargoGeigerReport,
  type GeigerReport,
  geigerReportToFindings,
} from "./tools/geiger.ts";
import { collectMiriReport, type MiriReport, miriReportToFindings } from "./tools/miri.ts";
import {
  collectCargoSemverViolations,
  type SemverViolation,
  semverViolationsToFindings,
} from "./tools/semver.ts";
import { SuggestionCompilerVerifier } from "./verifier.ts";

export type LensRunnerFn = (context: ReviewContext) => Promise<MultiLensRunResult>;
export type SkepticRunnerFn = (
  repoRoot: string,
  candidates: readonly Finding[],
  audit?: AuditLogger,
) => Promise<{ keptFindings: Finding[]; rejectedItems: ConsideredAndRejectedItem[] }>;

export interface CliDependencies {
  readonly githubClient?: GitHubClient;
  readonly lensRunner?: LensRunnerFn;
  readonly skepticRunner?: SkepticRunnerFn;
  readonly promptSelectPr?: (
    prs: ReadonlyArray<{ number: number; title: string }>,
  ) => Promise<number>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const OPTIONAL_TOOLS = ["deny", "geiger", "semver", "coverage", "miri"] as const;
type OptionalTool = (typeof OPTIONAL_TOOLS)[number];
const OPTIONAL_TOOL_SET = new Set<string>(OPTIONAL_TOOLS);

const STAGE_COMMANDS = new Set<PipelineStage>(["analyze", "review", "verify", "publish"]);

const HELP_TEXT = `peer — Local-First Rust PR Reviewer (4-Stage Composable Pipeline)

Commands:
  peer analyze [PR]        Stage 1: Deterministic Rust ground truth only (0 LLM calls)
  peer review  [PR]        Stage 1 -> 2: Reuses analyze, runs LLM lenses + cargo check verifier (default)
  peer verify  [PR]        Stage 1 -> 3: Reuses review, runs adversarial skeptic pass
  peer publish [PR]        Stage 4: Uploads latest saved stage (01, 02, or 03) to GitHub PR
  peer learn add "<rule>" [--scope "<glob>"] [--repo <path>]
  peer learn list [--repo <path>]
  peer learn remove <id> [--repo <path>]

Options:
  --repo <path>              Target local Rust git repository (default: cwd)
  --model <provider/model>   OpenCode model spec (default: hy4-flash-free)
  --profile <profile>        Strictness profile: quiet | chill | assertive (default: assertive)
  --tools <list|all>         Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all
  --concurrency <n>          Max parallel LLM sessions (1-16, default: 4)
  --fresh                    Ignore saved stage artifacts & checkpoint; re-run from scratch
  --submit                   For 'publish': submit as COMMENT instead of PENDING draft
  --allow-partial            Exit 0 and allow publishing even if a lens cohort fails
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

async function loadJsonIfExists<T>(
  filePath: string,
  parser: { parse: (val: unknown) => T },
): Promise<T | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return parser.parse(await file.json());
  } catch {
    return null;
  }
}

async function loadRawJsonIfExists<T>(filePath: string): Promise<T | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((text: string) => console.log(text));
  const writeErr = deps.stderr ?? ((text: string) => console.error(text));

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        model: { type: "string" },
        profile: { type: "string" },
        tools: { type: "string" },
        concurrency: { type: "string" },
        fresh: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
        "allow-partial": { type: "boolean", default: false },
        scope: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });

    if (parsed.values.help) {
      writeOut(HELP_TEXT);
      return 0;
    }

    const repoRoot = resolveGitTopLevel(resolve(parsed.values.repo ?? process.cwd()));
    const learningStore = new LearningStore(repoRoot);

    if (parsed.positionals[0] === "learn") {
      const action = parsed.positionals[1];
      if (action === "add") {
        const ruleText = parsed.positionals.slice(2).join(" ").trim();
        if (!ruleText) {
          writeErr('Usage: peer learn add "<rule>" [--scope "<glob>"]');
          return 1;
        }
        const entry = await learningStore.add({
          rule: ruleText,
          scope: parsed.values.scope ?? null,
        });
        writeOut(
          `Added learning [${entry.id}]${entry.scope ? ` (scope: ${entry.scope})` : ""}: ${entry.rule}`,
        );
        return 0;
      }
      if (action === "list") {
        const list = await learningStore.list();
        if (list.length === 0) {
          writeOut("No repository learnings recorded yet.");
        } else {
          for (const item of list) {
            writeOut(
              `[${item.id}] ${item.scope ? `(scope: ${item.scope}) ` : "(global) "}${item.rule}`,
            );
          }
        }
        return 0;
      }
      if (action === "remove") {
        const id = parsed.positionals[2]?.trim();
        if (!id) {
          writeErr("Usage: peer learn remove <id>");
          return 1;
        }
        const removed = await learningStore.remove(id);
        if (!removed) {
          writeErr(`Learning ID "${id}" not found.`);
          return 1;
        }
        writeOut(`Removed learning [${id}].`);
        return 0;
      }
      writeErr("Unknown learn subcommand. Expected: peer learn add | list | remove");
      return 1;
    }

    const positionals = [...parsed.positionals];
    let targetStage: PipelineStage = "review";
    if (positionals[0] && STAGE_COMMANDS.has(positionals[0] as PipelineStage)) {
      targetStage = positionals.shift() as PipelineStage;
    }

    const profile: ReviewProfile = ReviewProfileSchema.parse(parsed.values.profile ?? "assertive");
    const fresh = parsed.values.fresh ?? false;
    const submitReview = parsed.values.submit ?? false;
    const allowPartial = parsed.values["allow-partial"] ?? false;
    const enabledTools = parseToolsOption(parsed.values.tools);
    const enabledToolsList = Array.from(enabledTools).sort();

    if (submitReview && targetStage !== "publish") {
      writeErr("Error: --submit is only valid with `peer publish`.");
      return 1;
    }

    const rawConcurrency = parsed.values.concurrency;
    let concurrencyLimit = 4;
    if (rawConcurrency !== undefined) {
      const parsedConcurrency = Number.parseInt(rawConcurrency, 10);
      if (!/^\d+$/.test(rawConcurrency.trim()) || parsedConcurrency < 1 || parsedConcurrency > 16) {
        writeErr("Error: --concurrency must be an integer between 1 and 16.");
        return 1;
      }
      concurrencyLimit = parsedConcurrency;
    }

    // Step 1: Enforce clean working tree BEFORE any network or git mutation (except read-only publish)
    if (targetStage !== "publish") {
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
      deps.githubClient ??
      new GitHubClient({
        token: await resolveGitHubToken(),
      });

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
    const checkpointStore = new CheckpointStore(repoRoot);
    const modelSpec = parseModelSpec(parsed.values.model);
    const modelLabel = `${modelSpec.providerID}/${modelSpec.id}`;
    const runStartMs = Date.now();
    const commitDir = resolvePeerCommitDir(repoRoot, pr.number, pr.headSha);
    const existingManifest = !fresh
      ? await loadJsonIfExists<RunManifest>(join(commitDir, "run.json"), RunManifestSchema)
      : null;

    // ─── STAGE 4: PUBLISH (reads latest saved bundle; 0 builds, 0 LLM calls) ───
    if (targetStage === "publish") {
      const verifyBundle = await loadJsonIfExists(
        join(commitDir, "03-verify", "bundle.json"),
        ReviewBundleSchema,
      );
      const reviewBundle = await loadJsonIfExists(
        join(commitDir, "02-review", "bundle.json"),
        ReviewBundleSchema,
      );
      const analyzeBundle = await loadJsonIfExists(
        join(commitDir, "01-analyze", "bundle.json"),
        ReviewBundleSchema,
      );
      const analyzeContext = await loadJsonIfExists(
        join(commitDir, "01-analyze", "context.json"),
        AnalyzeStageContextSchema,
      );

      let sourceStage: PipelineStage | null = null;
      let bundleToPublish: ReviewBundle | null = null;
      if (verifyBundle) {
        sourceStage = "verify";
        bundleToPublish = verifyBundle;
      } else if (reviewBundle) {
        sourceStage = "review";
        bundleToPublish = reviewBundle;
      } else if (analyzeBundle) {
        sourceStage = "analyze";
        bundleToPublish = analyzeBundle;
      }

      if (!bundleToPublish || !sourceStage || !analyzeContext) {
        writeErr(
          `No local review artifacts found for PR #${pr.number} @ ${pr.headSha.slice(0, 7)}. Run \`peer analyze ${pr.number}\`, \`peer review ${pr.number}\`, or \`peer verify ${pr.number}\` first.`,
        );
        return 1;
      }

      const failedCohorts = bundleToPublish.failedCohorts ?? [];
      if (failedCohorts.length > 0 && !allowPartial) {
        writeErr(
          `Error: ${failedCohorts.length} review cohort(s) failed (${failedCohorts.join(", ")}). Refusing to publish partial review. Pass --allow-partial to override.`,
        );
        return 2;
      }

      const walkthroughCommentBody = renderWalkthroughComment(bundleToPublish);
      await githubClient.upsertWalkthroughComment(owner, repo, pr.number, walkthroughCommentBody);

      const inlineComments: InlineReviewCommentInput[] = bundleToPublish.findings.map(
        (finding) => ({
          path: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          body: renderInlineFindingComment(finding),
        }),
      );

      await githubClient.postPrReview({
        owner,
        repo,
        prNumber: pr.number,
        commitId: pr.headSha,
        comments: inlineComments,
        diffMap: analyzeContext.activeDiffMap,
        submit: submitReview,
        summaryBody: renderPrReviewSummaryBody(bundleToPublish),
      });

      await checkpointStore.save({
        prNumber: pr.number,
        baseSha: pr.baseSha,
        lastReviewedHeadSha: pr.headSha,
        reviewedAt: new Date().toISOString(),
        profile: bundleToPublish.profile,
      });

      const existingStages = existingManifest?.completedStages ?? [sourceStage];
      await writePublishStageArtifacts(
        repoRoot,
        bundleToPublish,
        {
          sourceStage,
          submitted: submitReview,
          inlineCommentsCount: inlineComments.length,
        },
        existingStages,
        {
          model: existingManifest?.model ?? modelLabel,
          durationMs: Date.now() - runStartMs,
          enabledTools: existingManifest?.enabledTools ?? enabledToolsList,
        },
      );

      writeOut(
        `Published PR #${pr.number} @ ${pr.headSha.slice(0, 7)} from stage \`${sourceStage}\` (${inlineComments.length} inline comment(s), mode=${submitReview ? "COMMENT" : "PENDING"}).\nReceipt: file://${resolve(commitDir, "04-publish", "report.md")}`,
      );
      return 0;
    }

    // ─── SHORT-CIRCUIT: Target stage already completed for this commit & profile ───
    if (
      !fresh &&
      existingManifest &&
      existingManifest.status === "completed" &&
      existingManifest.headSha === pr.headSha &&
      existingManifest.profile === profile &&
      existingManifest.completedStages.includes(targetStage)
    ) {
      const stageFolder =
        targetStage === "analyze"
          ? "01-analyze"
          : targetStage === "review"
            ? "02-review"
            : "03-verify";
      writeOut(
        `Already completed stage \`${targetStage}\` for PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (profile=${profile}, ${existingManifest.inlineFindingsCount} inline / ${existingManifest.outsideDiffFindingsCount} outside-diff findings).\nReport: file://${resolve(commitDir, stageFolder, "report.md")}\nPass --fresh to force a re-run.`,
      );
      return 0;
    }

    const auditLogger = new AuditLogger({
      repoRoot,
      prNumber: pr.number,
      headSha: pr.headSha,
      onProgress: (line) => writeOut(line),
    });

    await auditLogger.logEvent(
      "run.started",
      `▶ Resolved PR #${pr.number} (${owner}/${repo}: "${pr.title}") head=${pr.headSha.slice(0, 7)} base=${pr.baseSha.slice(0, 7)} target=${targetStage}`,
      {
        owner,
        repo,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        targetStage,
        model: modelLabel,
        enabledTools: enabledToolsList,
        fresh,
      },
    );

    // ─── STAGE 1: ANALYZE (reuse saved 01-analyze/context.json if valid) ───
    let analyzeContext: AnalyzeStageContext | null = !fresh
      ? await loadJsonIfExists(
          join(commitDir, "01-analyze", "context.json"),
          AnalyzeStageContextSchema,
        )
      : null;

    if (
      analyzeContext &&
      (analyzeContext.headSha !== pr.headSha || analyzeContext.profile !== profile)
    ) {
      analyzeContext = null;
    }

    let analyzeBundle: ReviewBundle | null = analyzeContext
      ? await loadJsonIfExists(join(commitDir, "01-analyze", "bundle.json"), ReviewBundleSchema)
      : null;

    let symbolGraph: RustSymbolGraph | undefined;
    let cargoLockDiff: CargoLockDiff | null = null;
    let geigerReport: GeigerReport | null = null;
    let semverViolations: SemverViolation[] = [];
    let coverageReport: CoverageReport | null = null;
    let miriReport: MiriReport | null = null;

    if (analyzeContext) {
      const toolsDir = join(commitDir, "01-analyze", "tools");
      symbolGraph =
        (await loadRawJsonIfExists<RustSymbolGraph>(join(toolsDir, "symbol-graph.json"))) ??
        undefined;
      cargoLockDiff = await loadRawJsonIfExists<CargoLockDiff>(
        join(toolsDir, "cargo-lock-diff.json"),
      );
      geigerReport = await loadRawJsonIfExists<GeigerReport>(join(toolsDir, "geiger.json"));
      semverViolations =
        (await loadRawJsonIfExists<SemverViolation[]>(join(toolsDir, "semver.json"))) ?? [];
      coverageReport = await loadRawJsonIfExists<CoverageReport>(join(toolsDir, "coverage.json"));
      miriReport = await loadRawJsonIfExists<MiriReport>(join(toolsDir, "miri.json"));
      await auditLogger.logEvent(
        "stage.analyze.reused",
        `▶ Stage 1 (analyze): Reusing cached deterministic analysis from ${join(commitDir, "01-analyze")}`,
      );
    } else {
      await withInPlaceCheckout(
        { repoRoot, targetSha: pr.headSha, prNumber: pr.number },
        async () => {
          let { diffBaseSha, isIncremental } = await checkpointStore.resolveDiffBase({
            prNumber: pr.number,
            prBaseSha: pr.baseSha,
            currentHeadSha: pr.headSha,
            fresh,
            profile,
          });

          let diffText: string;
          const diffRangeSpec = isIncremental
            ? `${diffBaseSha}..${pr.headSha}`
            : `${diffBaseSha}...${pr.headSha}`;
          const localDiffAttempt = tryGitRawSync(repoRoot, [
            "diff",
            "--no-color",
            "--unified=3",
            diffRangeSpec,
          ]);
          if (localDiffAttempt.ok && (isIncremental || localDiffAttempt.stdout.length > 0)) {
            diffText = localDiffAttempt.stdout;
          } else {
            if (isIncremental) {
              isIncremental = false;
              diffBaseSha = pr.baseSha;
            }
            diffText = await githubClient.getPullRequestDiff(owner, repo, pr.number);
          }

          const rawDiffMap = parseUnifiedDiff(diffText);
          const diffMap = filterCodeOnlyDiffMap(rawDiffMap);
          let activeDiffMap = diffMap;
          if (isIncremental) {
            const fullPrDiffAttempt = tryGitRawSync(repoRoot, [
              "diff",
              "--no-color",
              "--unified=3",
              `${pr.baseSha}...${pr.headSha}`,
            ]);
            if (fullPrDiffAttempt.ok && fullPrDiffAttempt.stdout.length > 0) {
              activeDiffMap = filterCodeOnlyDiffMap(parseUnifiedDiff(fullPrDiffAttempt.stdout));
            }
          }

          const modifiedFiles = new Set(Object.keys(diffMap));
          const excludedFiles = Object.keys(rawDiffMap).filter((fp) => !modifiedFiles.has(fp));
          const baseline = collectRustToolchainBaseline(repoRoot);

          await auditLogger.logEvent(
            "stage.analyze.started",
            `▶ Stage 1 (analyze): Running deterministic Rust analyzers on ${modifiedFiles.size} file(s)...`,
          );

          const [
            crateGraph,
            clippyDiagnostics,
            securityAdvisories,
            lockDiff,
            denyDiagnostics,
            builtGraph,
          ] = await Promise.all([
            collectCrateGraph(repoRoot),
            modifiedFiles.size > 0
              ? collectClippyDiagnostics(repoRoot, modifiedFiles, diffMap)
              : Promise.resolve([]),
            modifiedFiles.size > 0
              ? collectSecurityAdvisories(repoRoot, { baseSha: pr.baseSha })
              : Promise.resolve([]),
            collectCargoLockDiff(repoRoot, pr.baseSha),
            modifiedFiles.size > 0
              ? collectCargoDenyDiagnostics(repoRoot, { force: enabledTools.has("deny") })
              : Promise.resolve([]),
            modifiedFiles.size > 0
              ? buildRustSymbolGraph(repoRoot, diffMap)
              : Promise.resolve({ nodes: [] }),
          ]);

          symbolGraph = builtGraph;
          cargoLockDiff = lockDiff;
          const modifiedCrates = new Set(
            Array.from(modifiedFiles)
              .map((fp) => resolveFileArchitecturalLayer(crateGraph, fp).crateName)
              .filter((name) => Boolean(crateGraph.crates[name])),
          );

          const [geigerRes, semverRes, coverageRes, miriRes] = await Promise.all([
            collectCargoGeigerReport(repoRoot, {
              enabled: enabledTools.has("geiger"),
              crateGraph,
            }),
            collectCargoSemverViolations(repoRoot, {
              enabled: enabledTools.has("semver"),
              baseSha: pr.baseSha,
            }),
            collectCargoLlvmCovReport(repoRoot, diffMap, {
              enabled: enabledTools.has("coverage"),
              packages: Array.from(modifiedCrates),
            }),
            collectMiriReport(repoRoot, diffMap, {
              enabled: enabledTools.has("miri"),
              crateGraph,
            }),
          ]);

          geigerReport = geigerRes;
          semverViolations = semverRes;
          coverageReport = coverageRes;
          miriReport = miriRes;

          const clippyFindings = clippyToFindings(clippyDiagnostics, diffMap);
          const auditFindings = await advisoriesToFindings(
            securityAdvisories,
            repoRoot,
            crateGraph,
          );
          const denyFindings = denyDiagnosticsToFindings(denyDiagnostics);
          const geigerFindings = geigerReport
            ? geigerReportToFindings(geigerReport, modifiedCrates, crateGraph)
            : [];
          const semverFindings = semverViolationsToFindings(semverViolations);
          const coverageFindings = coverageReport ? coverageReportToFindings(coverageReport) : [];
          const miriFindings = miriReport ? miriReportToFindings(miriReport) : [];

          const deterministicFindings = [
            ...clippyFindings,
            ...auditFindings,
            ...denyFindings,
            ...geigerFindings,
            ...semverFindings,
            ...coverageFindings,
            ...miriFindings,
          ];

          const partitionedDet = partitionAndFilterFindings(
            deterministicFindings,
            diffMap,
            profile,
          );

          analyzeContext = AnalyzeStageContextSchema.parse({
            pr,
            diffBaseSha,
            headSha: pr.headSha,
            isIncremental,
            profile,
            baseline,
            crateGraph,
            diffMap,
            activeDiffMap,
            excludedFiles,
            clippyDiagnostics,
            securityAdvisories,
            enabledTools: enabledToolsList,
            deterministicFindings,
            generatedAt: new Date().toISOString(),
          });

          analyzeBundle = ReviewBundleSchema.parse({
            pr,
            diffBaseSha,
            headSha: pr.headSha,
            isIncremental,
            profile,
            baseline,
            walkthrough: {
              summary: `Deterministic static/dynamic analysis across ${modifiedFiles.size} Rust file(s) (${clippyDiagnostics.length} Clippy, ${securityAdvisories.length} CVE/RustSec, ${deterministicFindings.length} total deterministic finding(s)).`,
              changes: Array.from(modifiedFiles).map((filePath) => {
                const layerInfo = resolveFileArchitecturalLayer(crateGraph, filePath);
                return {
                  layer: layerInfo.layer,
                  crateName: layerInfo.crateName,
                  filePath,
                  summary: "Analyzed by deterministic Rust toolchain",
                };
              }),
              sequenceDiagram: null,
              triage: {
                reviewEffort: Math.min(5, Math.max(1, Math.ceil(modifiedFiles.size / 3))),
                mergeRisk: deterministicFindings.some((f) => f.severity === "Critical")
                  ? "Critical"
                  : deterministicFindings.some((f) => f.severity === "Major")
                    ? "High"
                    : "Low",
                rationale: "Deterministic Stage 1 analysis (0 LLM calls).",
              },
            },
            findings: partitionedDet.inlineFindings,
            outsideDiffFindings: partitionedDet.outsideDiffFindings,
            nitpickFindings: partitionedDet.nitpickFindings,
            consideredAndRejected: [],
            deletionsProposed: clippyDiagnostics
              .filter((d) => d.code === "dead_code")
              .map((d) => ({
                pathOrSymbol: `${d.filePath}:${d.startLine}`,
                reachabilityEvidence: `rustc dead_code diagnostic: ${d.message}`,
                replacement: "Remove dead symbol or wire into production caller",
              })),
            openQuestions: [],
            notReviewed: excludedFiles.map((f) => `${f} (non-Rust or documentation file skipped)`),
            failedCohorts: [],
            clippyDiagnostics,
            securityAdvisories,
            generatedAt: analyzeContext.generatedAt,
          });

          const extraToolOutputs: Record<string, unknown> = {};
          if (cargoLockDiff) extraToolOutputs["cargo-lock-diff"] = cargoLockDiff;
          if (denyDiagnostics.length > 0) extraToolOutputs.deny = denyDiagnostics;
          if (geigerReport) extraToolOutputs.geiger = geigerReport;
          if (semverViolations.length > 0) extraToolOutputs.semver = semverViolations;
          if (coverageReport) extraToolOutputs.coverage = coverageReport;
          if (miriReport) extraToolOutputs.miri = miriReport;

          await writeAnalyzeStageArtifacts(repoRoot, analyzeContext, analyzeBundle, {
            model: "deterministic",
            durationMs: Date.now() - runStartMs,
            enabledTools: enabledToolsList,
            symbolGraph,
            extraToolOutputs,
          });
        },
      );
    }

    if (!analyzeContext || !analyzeBundle) {
      writeErr("Internal error: Stage 1 (analyze) produced no context.");
      return 1;
    }

    if (targetStage === "analyze") {
      writeOut(formatTerminalReport(analyzeBundle, repoRoot, join(commitDir, "01-analyze")));
      return 0;
    }

    // ─── STAGE 2: REVIEW (OpenCode multi-lens + Judge + cargo check verifier) ───
    let reviewBundle: ReviewBundle | null =
      !fresh && existingManifest?.completedStages.includes("review")
        ? await loadJsonIfExists(join(commitDir, "02-review", "bundle.json"), ReviewBundleSchema)
        : null;

    if (reviewBundle) {
      await auditLogger.logEvent(
        "stage.review.reused",
        `▶ Stage 2 (review): Reusing cached LLM review from ${join(commitDir, "02-review")}`,
      );
    } else {
      const ctxData = analyzeContext;
      const modifiedFiles = new Set(Object.keys(ctxData.diffMap));

      if (modifiedFiles.size === 0 && !deps.lensRunner) {
        reviewBundle = analyzeBundle;
        await writeReviewStageArtifacts(repoRoot, reviewBundle, {
          model: modelLabel,
          durationMs: Date.now() - runStartMs,
          enabledTools: enabledToolsList,
        });
      } else {
        reviewBundle = await withInPlaceCheckout(
          { repoRoot, targetSha: pr.headSha, prNumber: pr.number },
          async () => {
            const learnings = await learningStore.getMatchingLearnings(modifiedFiles, pr.baseSha);
            const reviewContext: ReviewContext = {
              repoRoot,
              pr,
              diffBaseSha: ctxData.diffBaseSha,
              headSha: pr.headSha,
              isIncremental: ctxData.isIncremental,
              fresh,
              crateGraph: ctxData.crateGraph,
              diffMap: ctxData.diffMap,
              clippyDiagnostics: ctxData.clippyDiagnostics,
              securityAdvisories: ctxData.securityAdvisories,
              cargoLockDiff,
              geigerReport,
              semverViolations,
              coverageReport,
              miriReport,
              symbolGraph,
              learnings,
              auditLogger,
            };

            await auditLogger.logEvent(
              "stage.review.started",
              `▶ Stage 2 (review): Running OpenCode review lenses (model: ${modelLabel})...`,
            );

            const lensRunner: LensRunnerFn =
              deps.lensRunner ??
              (async (ctx) => {
                const orchestrator = new OpenCodeMultiLensOrchestrator({
                  model: modelSpec,
                  concurrencyLimit,
                  skeptic: false,
                });
                return await orchestrator.runAllLenses(ctx);
              });

            const lensResult = await lensRunner(reviewContext);
            runGitSync(repoRoot, ["checkout", "--", "."]);

            const partitioned = partitionAndFilterFindings(
              [...ctxData.deterministicFindings, ...lensResult.findings],
              ctxData.diffMap,
              profile,
            );

            const hasBaselineCompileErrors = ctxData.clippyDiagnostics.some(
              (d) => d.level === "error",
            );
            const verifier = new SuggestionCompilerVerifier();
            const verifiedInline = hasBaselineCompileErrors
              ? partitioned.inlineFindings
              : await verifier.verifySuggestions(repoRoot, partitioned.inlineFindings, auditLogger);

            const existingDeletionRefs = new Set(
              (lensResult.deletionsProposed ?? []).map((d) => d.pathOrSymbol),
            );
            const rustcDeadCodeDeletions: DeletionProposedItem[] = ctxData.clippyDiagnostics
              .filter((d) => d.code === "dead_code")
              .map((d) => ({
                pathOrSymbol: `${d.filePath}:${d.startLine}`,
                reachabilityEvidence: `rustc dead_code diagnostic: ${d.message}`,
                replacement: "Remove dead symbol or wire into production caller",
              }))
              .filter((d) => !existingDeletionRefs.has(d.pathOrSymbol));

            return ReviewBundleSchema.parse({
              pr,
              diffBaseSha: ctxData.diffBaseSha,
              headSha: pr.headSha,
              isIncremental: ctxData.isIncremental,
              profile,
              baseline: ctxData.baseline,
              walkthrough: lensResult.walkthrough,
              findings: verifiedInline,
              outsideDiffFindings: partitioned.outsideDiffFindings,
              nitpickFindings: partitioned.nitpickFindings,
              consideredAndRejected: lensResult.consideredAndRejected ?? [],
              deletionsProposed: [
                ...(lensResult.deletionsProposed ?? []),
                ...rustcDeadCodeDeletions,
              ],
              openQuestions: lensResult.openQuestions ?? [],
              notReviewed: ctxData.excludedFiles.map(
                (f) => `${f} (non-Rust or documentation file skipped)`,
              ),
              failedCohorts: lensResult.failedCohorts ?? [],
              clippyDiagnostics: ctxData.clippyDiagnostics,
              securityAdvisories: ctxData.securityAdvisories,
              generatedAt: new Date().toISOString(),
            });
          },
        );

        await writeReviewStageArtifacts(repoRoot, reviewBundle, {
          model: modelLabel,
          durationMs: Date.now() - runStartMs,
          enabledTools: enabledToolsList,
        });
      }
    }

    const failedCohortsCount = reviewBundle.failedCohorts?.length ?? 0;
    if (targetStage === "review") {
      writeOut(formatTerminalReport(reviewBundle, repoRoot, join(commitDir, "02-review")));
      if (failedCohortsCount > 0 && !allowPartial) {
        writeErr(
          `Error: ${failedCohortsCount} review cohort(s) failed (${(reviewBundle.failedCohorts ?? []).join(", ")}). Pass --allow-partial to override.`,
        );
        return 2;
      }
      return 0;
    }

    // ─── STAGE 3: VERIFY (Adversarial skeptic pass over LLM findings) ───
    const verifyBundle = await withInPlaceCheckout(
      { repoRoot, targetSha: pr.headSha, prNumber: pr.number },
      async () => {
        await auditLogger.logEvent(
          "stage.verify.started",
          `▶ Stage 3 (verify): Running adversarial skeptic pass over Stage 2 findings...`,
        );

        const skepticRunner: SkepticRunnerFn =
          deps.skepticRunner ??
          (async (root, candidates, audit) => {
            const orchestrator = new OpenCodeMultiLensOrchestrator({
              model: modelSpec,
              concurrencyLimit,
            });
            return await orchestrator.verifyFindingsWithSkeptic(root, candidates, audit);
          });

        const llmInline = reviewBundle.findings.filter(
          (f) => f.source !== "clippy" && f.source !== "audit",
        );
        const detInline = reviewBundle.findings.filter(
          (f) => f.source === "clippy" || f.source === "audit",
        );
        const llmOutside = (reviewBundle.outsideDiffFindings ?? []).filter(
          (f) => f.source !== "clippy" && f.source !== "audit",
        );
        const detOutside = (reviewBundle.outsideDiffFindings ?? []).filter(
          (f) => f.source === "clippy" || f.source === "audit",
        );

        const allLlmCandidates = [...llmInline, ...llmOutside];
        const skepticRes = await skepticRunner(repoRoot, allLlmCandidates, auditLogger);
        const keptIds = new Set(skepticRes.keptFindings.map((f) => f.id));

        const updatedBundle = ReviewBundleSchema.parse({
          ...reviewBundle,
          findings: [...detInline, ...llmInline.filter((f) => keptIds.has(f.id))],
          outsideDiffFindings: [...detOutside, ...llmOutside.filter((f) => keptIds.has(f.id))],
          consideredAndRejected: [
            ...(reviewBundle.consideredAndRejected ?? []),
            ...skepticRes.rejectedItems,
          ],
          generatedAt: new Date().toISOString(),
        });

        await writeVerifyStageArtifacts(
          repoRoot,
          updatedBundle,
          {
            keptCount: skepticRes.keptFindings.length,
            refutedItems: skepticRes.rejectedItems,
          },
          {
            model: modelLabel,
            durationMs: Date.now() - runStartMs,
            enabledTools: enabledToolsList,
          },
        );

        return updatedBundle;
      },
    );

    writeOut(formatTerminalReport(verifyBundle, repoRoot, join(commitDir, "03-verify")));
    if (failedCohortsCount > 0 && !allowPartial) {
      writeErr(
        `Error: ${failedCohortsCount} review cohort(s) failed (${(verifyBundle.failedCohorts ?? []).join(", ")}). Pass --allow-partial to override.`,
      );
      return 2;
    }
    return 0;
  } catch (err) {
    writeErr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
