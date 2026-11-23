import { join } from "node:path";

import {
  collectCargoLlvmCovReport,
  type CoverageReport,
  coverageReportToFindings,
} from "../analyzers/coverage.ts";
import { collectCargoDenyDiagnostics, denyDiagnosticsToFindings } from "../analyzers/deny.ts";
import {
  collectCargoGeigerReport,
  type GeigerReport,
  geigerReportToFindings,
} from "../analyzers/geiger.ts";
import { collectMiriReport, type MiriReport, miriReportToFindings } from "../analyzers/miri.ts";
import {
  collectClippyDiagnostics,
  collectCrateGraph,
  collectRustToolchainBaseline,
  resolveFileArchitecturalLayer,
} from "../analyzers/rust.ts";
import {
  type CargoLockDiff,
  collectCargoLockDiff,
  collectSecurityAdvisories,
} from "../analyzers/security.ts";
import {
  collectCargoSemverViolations,
  type SemverViolation,
  semverViolationsToFindings,
} from "../analyzers/semver.ts";
import { buildRustSymbolGraph, type RustSymbolGraph } from "../analyzers/symbol-graph.ts";
import { filterCodeOnlyDiffMap, parseUnifiedDiff } from "../domain/diff.ts";
import {
  type AnalyzeStageContext,
  AnalyzeStageContextSchema,
  type PullRequestMetadata,
  type ReviewBundle,
  ReviewBundleSchema,
  type ReviewProfile,
} from "../domain/models.ts";
import type { GitHubClient } from "../github/client.ts";
import {
  advisoriesToFindings,
  clippyToFindings,
  partitionAndFilterFindings,
} from "../judge/partition.ts";
import { buildReviewContextPrompt } from "../llm/context.ts";
import {
  loadJsonIfExists,
  loadRawJsonIfExists,
  writeAnalyzeStageArtifacts,
} from "../workspace/artifacts.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";
import { DEFAULT_PEER_CONFIG, type PeerConfig } from "../workspace/config.ts";
import { type CheckpointStore, tryGitRawSync, withInPlaceCheckout } from "../workspace/git.ts";
import { LearningStore } from "../workspace/learnings.ts";

export type OptionalTool = "deny" | "geiger" | "semver" | "coverage" | "miri";

export interface AnalyzeStageInput {
  readonly repoRoot: string;
  readonly commitDir: string;
  readonly owner: string;
  readonly repo: string;
  readonly pr: PullRequestMetadata;
  readonly profile: ReviewProfile;
  readonly fresh: boolean;
  readonly enabledTools: ReadonlySet<OptionalTool>;
  readonly enabledToolsList: readonly string[];
  readonly peerConfig?: PeerConfig;
  readonly runStartMs: number;
  readonly githubClient: GitHubClient;
  readonly checkpointStore: CheckpointStore;
  readonly auditLogger: AuditLogger;
}

export interface AnalyzeStageOutput {
  readonly analyzeContext: AnalyzeStageContext;
  readonly analyzeBundle: ReviewBundle;
  readonly symbolGraph?: RustSymbolGraph;
  readonly cargoLockDiff: CargoLockDiff | null;
  readonly geigerReport: GeigerReport | null;
  readonly semverViolations: SemverViolation[];
  readonly coverageReport: CoverageReport | null;
  readonly miriReport: MiriReport | null;
}

export async function runAnalyzeStage(input: AnalyzeStageInput): Promise<AnalyzeStageOutput> {
  const {
    repoRoot,
    commitDir,
    owner,
    repo,
    pr,
    profile,
    fresh,
    enabledTools,
    enabledToolsList,
    peerConfig = DEFAULT_PEER_CONFIG,
    runStartMs,
    githubClient,
    checkpointStore,
    auditLogger,
  } = input;

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

  if (analyzeContext && analyzeBundle) {
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
    return {
      analyzeContext,
      analyzeBundle,
      symbolGraph,
      cargoLockDiff,
      geigerReport,
      semverViolations,
      coverageReport,
      miriReport,
    };
  }

  await withInPlaceCheckout({ repoRoot, targetSha: pr.headSha, prNumber: pr.number }, async () => {
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
    const diffMap = filterCodeOnlyDiffMap(rawDiffMap, peerConfig.diff.ignore);
    let activeDiffMap = diffMap;
    if (isIncremental) {
      const fullPrDiffAttempt = tryGitRawSync(repoRoot, [
        "diff",
        "--no-color",
        "--unified=3",
        `${pr.baseSha}...${pr.headSha}`,
      ]);
      if (fullPrDiffAttempt.ok && fullPrDiffAttempt.stdout.length > 0) {
        activeDiffMap = filterCodeOnlyDiffMap(
          parseUnifiedDiff(fullPrDiffAttempt.stdout),
          peerConfig.diff.ignore,
        );
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
      modifiedFiles.size > 0 && peerConfig.tools.clippy
        ? collectClippyDiagnostics(repoRoot, modifiedFiles, diffMap)
        : Promise.resolve([]),
      modifiedFiles.size > 0 && peerConfig.tools.audit
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
    const auditFindings = await advisoriesToFindings(securityAdvisories, repoRoot, crateGraph);
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

    const partitionedDet = partitionAndFilterFindings(deterministicFindings, diffMap, profile);

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

    const learnings = await new LearningStore(repoRoot).getMatchingLearnings(
      modifiedFiles,
      pr.baseSha,
      peerConfig.rules,
    );
    const promptContextMd = buildReviewContextPrompt({
      repoRoot,
      pr,
      diffBaseSha,
      headSha: pr.headSha,
      isIncremental,
      fresh,
      crateGraph,
      diffMap,
      clippyDiagnostics,
      securityAdvisories,
      cargoLockDiff,
      geigerReport,
      semverViolations,
      coverageReport,
      miriReport,
      symbolGraph,
      learnings,
      auditLogger,
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
      promptContextMd,
      extraToolOutputs,
    });
  });

  if (!analyzeContext || !analyzeBundle) {
    throw new Error("Internal error: Stage 1 (analyze) produced no context.");
  }

  return {
    analyzeContext,
    analyzeBundle,
    symbolGraph,
    cargoLockDiff,
    geigerReport,
    semverViolations,
    coverageReport,
    miriReport,
  };
}
