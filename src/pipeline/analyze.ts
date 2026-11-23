import { join } from "node:path";

import { collectAstDeterministicFindings } from "../analyzers/ast-detectors.ts";
import {
  collectCargoLlvmCovReport,
  type CoverageReport,
  coverageReportToFindings,
} from "../analyzers/coverage.ts";
import {
  CargoDenyMissingError,
  collectCargoDenyDiagnostics,
  denyDiagnosticsToFindings,
  hasCargoDenyConfig,
} from "../analyzers/deny.ts";
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
  CargoAuditMissingError,
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
import { filterCodeOnlyDiffMap, findSensitiveFiles, parseUnifiedDiff } from "../domain/diff.ts";
import {
  type AnalyzeStageContext,
  AnalyzeStageContextSchema,
  FindingSchema,
  PEER_VERSION,
  type PullRequestMetadata,
  type ReviewBundle,
  ReviewBundleSchema,
  type ReviewProfile,
  type ToolOutcomeDetail,
} from "../domain/models.ts";
import type { GitHubClient } from "../github/client.ts";
import {
  advisoriesToFindings,
  clippyToFindings,
  partitionAndFilterFindings,
} from "../judge/partition.ts";
import { planAllSubsystemCohorts } from "../llm/cohorts.ts";
import { buildCohortContextPrompt, buildReviewContextPrompt } from "../llm/context.ts";
import {
  loadJsonIfExists,
  loadRawJsonIfExists,
  writeAnalyzeStageArtifacts,
} from "../workspace/artifacts.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";
import { DEFAULT_PEER_CONFIG, type PeerConfig } from "../workspace/config.ts";
import { type CheckpointStore, tryGitRawSync, withInPlaceCheckout } from "../workspace/git.ts";
import { loadRepoInstructions } from "../workspace/instructions.ts";
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
  readonly noCheckout?: boolean;
  readonly enabledTools: ReadonlySet<OptionalTool>;
  readonly enabledToolsList: readonly string[];
  readonly explicitTools?: ReadonlySet<string>;
  readonly peerConfig?: PeerConfig;
  readonly configHash?: string;
  readonly runStartMs: number;
  readonly githubClient: GitHubClient;
  readonly checkpointStore: CheckpointStore;
  readonly auditLogger: AuditLogger;
}

export interface AnalyzeStageOutput {
  readonly analyzeContext: AnalyzeStageContext;
  readonly analyzeBundle: ReviewBundle;
  readonly skippedTools: readonly string[];
  readonly toolOutcomes: Readonly<Record<string, ToolOutcomeDetail>>;
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
    noCheckout = false,
    enabledTools,
    enabledToolsList,
    explicitTools = enabledTools,
    peerConfig = DEFAULT_PEER_CONFIG,
    configHash = "default",
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

  const sameTools = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  };

  if (
    analyzeContext &&
    (analyzeContext.headSha !== pr.headSha ||
      analyzeContext.pr.baseSha !== pr.baseSha ||
      analyzeContext.profile !== profile ||
      analyzeContext.configHash !== configHash ||
      analyzeContext.peerVersion !== PEER_VERSION ||
      !sameTools(analyzeContext.enabledTools, enabledToolsList))
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
  const skippedTools: string[] = [];
  const toolOutcomes: Record<string, ToolOutcomeDetail> = {};

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
      skippedTools,
      toolOutcomes,
      symbolGraph,
      cargoLockDiff,
      geigerReport,
      semverViolations,
      coverageReport,
      miriReport,
    };
  }

  await withInPlaceCheckout(
    { repoRoot, targetSha: pr.headSha, prNumber: pr.number, noCheckout },
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

      for (const optTool of ["deny", "geiger", "semver", "coverage", "miri"] as const) {
        if (!enabledTools.has(optTool)) {
          skippedTools.push(`${optTool} (not enabled; pass --tools ${optTool} or --tools all)`);
          toolOutcomes[optTool] = {
            status: "skipped",
            findingsCount: 0,
            reason: "not_enabled",
            remediationCommand: `peer analyze ${pr.number} --tools ${optTool}`,
          };
        }
      }

      const runAuditWithPolicy = async () => {
        if (modifiedFiles.size === 0 || !peerConfig.tools.audit) {
          toolOutcomes.audit = {
            status: "skipped",
            findingsCount: 0,
            reason: modifiedFiles.size === 0 ? "no_modified_files" : "not_enabled",
          };
          return [];
        }
        try {
          return await collectSecurityAdvisories(repoRoot, { baseSha: pr.baseSha });
        } catch (err) {
          if (err instanceof CargoAuditMissingError && !explicitTools.has("audit")) {
            skippedTools.push(
              "cargo-audit (not installed — install with: cargo install cargo-audit)",
            );
            toolOutcomes.audit = {
              status: "skipped",
              findingsCount: 0,
              reason: "missing_binary",
              remediationCommand: "cargo install cargo-audit",
            };
            return [];
          }
          throw err;
        }
      };

      const runDenyWithPolicy = async () => {
        if (modifiedFiles.size === 0) {
          return [];
        }
        const hasConfig = await hasCargoDenyConfig(repoRoot);
        if (!hasConfig) {
          if (enabledTools.has("deny")) {
            skippedTools.push(
              "deny (skipped: no deny.toml or .cargo/deny.toml in repository; run 'cargo deny init' to configure)",
            );
            toolOutcomes.deny = {
              status: "skipped",
              findingsCount: 0,
              reason: "missing_config",
              remediationCommand: "cargo deny init",
            };
          }
          return [];
        }
        try {
          return await collectCargoDenyDiagnostics(repoRoot, { force: true });
        } catch (err) {
          if (err instanceof CargoDenyMissingError && !explicitTools.has("deny")) {
            skippedTools.push(
              "cargo-deny (not installed — install with: cargo install cargo-deny)",
            );
            toolOutcomes.deny = {
              status: "skipped",
              findingsCount: 0,
              reason: "missing_binary",
              remediationCommand: "cargo install cargo-deny",
            };
            return [];
          }
          throw err;
        }
      };

      const [
        crateGraph,
        clippyDiagnostics,
        securityAdvisories,
        lockDiff,
        denyDiagnostics,
        builtGraph,
        astFindings,
      ] = await Promise.all([
        collectCrateGraph(repoRoot),
        modifiedFiles.size > 0 && peerConfig.tools.clippy
          ? collectClippyDiagnostics(repoRoot, modifiedFiles, diffMap)
          : Promise.resolve([]),
        runAuditWithPolicy(),
        collectCargoLockDiff(repoRoot, pr.baseSha),
        runDenyWithPolicy(),
        modifiedFiles.size > 0
          ? buildRustSymbolGraph(repoRoot, diffMap)
          : Promise.resolve({ nodes: [] }),
        modifiedFiles.size > 0
          ? collectAstDeterministicFindings(repoRoot, diffMap, peerConfig.detectors)
          : Promise.resolve([]),
      ]);

      symbolGraph = builtGraph;
      cargoLockDiff = lockDiff;

      const modifiedCrates = new Set(
        Array.from(modifiedFiles)
          .map((fp) => resolveFileArchitecturalLayer(crateGraph, fp).crateName)
          .filter((name) => Boolean(crateGraph.crates[name])),
      );

      // Why: Heavy optional Cargo analyzers (`geiger`, `semver-checks`, `llvm-cov`, `miri`) all
      // acquire the workspace Cargo build lock (`target/`) and compile rustdoc/instrumented binaries.
      // Running them sequentially prevents lock contention and ensures each tool gets its own full
      // timeout window instead of starving while waiting for another Cargo invocation.
      geigerReport = await collectCargoGeigerReport(repoRoot, {
        enabled: enabledTools.has("geiger"),
        crateGraph,
      });
      semverViolations = await collectCargoSemverViolations(repoRoot, {
        enabled: enabledTools.has("semver"),
        baseSha: pr.baseSha,
      });
      coverageReport = await collectCargoLlvmCovReport(repoRoot, diffMap, {
        enabled: enabledTools.has("coverage"),
        packages: Array.from(modifiedCrates),
      });
      miriReport = await collectMiriReport(repoRoot, diffMap, {
        enabled: enabledTools.has("miri"),
        crateGraph,
      });
      if (miriReport?.skippedReason) {
        skippedTools.push(`miri (skipped: ${miriReport.skippedReason})`);
      }

      const clippyFindings = clippyToFindings(clippyDiagnostics, diffMap);
      const auditFindings = await advisoriesToFindings(securityAdvisories, repoRoot, crateGraph);
      const denyFindings = denyDiagnosticsToFindings(denyDiagnostics);
      const geigerFindings = geigerReport
        ? geigerReportToFindings(geigerReport, modifiedCrates, crateGraph)
        : [];
      const semverFindings = semverViolationsToFindings(semverViolations);
      const coverageFindings = coverageReport ? coverageReportToFindings(coverageReport) : [];
      const miriFindings = miriReport ? miriReportToFindings(miriReport) : [];

      toolOutcomes.clippy ??= { status: "ok", findingsCount: clippyFindings.length };
      toolOutcomes.audit ??= { status: "ok", findingsCount: auditFindings.length };
      if (enabledTools.has("deny") && !toolOutcomes.deny) {
        toolOutcomes.deny = { status: "ok", findingsCount: denyFindings.length };
      }
      if (enabledTools.has("geiger") && !toolOutcomes.geiger) {
        toolOutcomes.geiger = { status: "ok", findingsCount: geigerFindings.length };
      }
      if (enabledTools.has("semver") && !toolOutcomes.semver) {
        toolOutcomes.semver = { status: "ok", findingsCount: semverFindings.length };
      }
      if (enabledTools.has("coverage") && !toolOutcomes.coverage) {
        toolOutcomes.coverage = { status: "ok", findingsCount: coverageFindings.length };
      }
      if (enabledTools.has("miri")) {
        toolOutcomes.miri = miriReport?.skippedReason
          ? { status: "skipped", findingsCount: 0, reason: "no_unsafe_in_diff" }
          : { status: "ok", findingsCount: miriFindings.length };
      }
      const sensitiveFileFindings = findSensitiveFiles(Object.keys(rawDiffMap)).map((filePath) =>
        FindingSchema.parse({
          id: `audit-sensitive-file-${filePath.replace(/[^a-z0-9]+/gi, "-")}`,
          filePath,
          startLine: 1,
          endLine: 1,
          severity: "Major",
          type: "Security",
          epistemicState: "NEEDS-RUNTIME-VERIFICATION",
          evidenceMechanism: "Security",
          title: `Sensitive build/toolchain/CI file modified: \`${filePath}\``,
          body: `PR modifies security-sensitive configuration file \`${filePath}\`. Review carefully for build-script injection, toolchain overrides, CI permission escalation, or policy weakening.`,
          rootCause: `Modification to sensitive configuration file ${filePath}`,
          blastRadius: "Build pipeline / toolchain / CI security boundary",
          reversible: true,
          dependsOn: null,
          verificationCommand: `git diff ${diffBaseSha.slice(0, 7)}..${pr.headSha.slice(0, 7)} -- ${filePath}`,
          traceability: `deterministic sensitive-file detector (${filePath})`,
          suggestion: null,
          suggestionVerified: false,
          agentPrompt: `Manually audit changes to sensitive file \`${filePath}\` for supply-chain, CI, or toolchain security risks.`,
          confidence: 1.0,
          source: "audit",
        }),
      );

      const deterministicFindings = [
        ...clippyFindings,
        ...auditFindings,
        ...denyFindings,
        ...geigerFindings,
        ...semverFindings,
        ...coverageFindings,
        ...miriFindings,
        ...astFindings,
        ...sensitiveFileFindings,
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
        configHash,
        peerVersion: PEER_VERSION,
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
        notReviewed: [
          ...skippedTools.map((t) => `Tool skipped: ${t}`),
          ...excludedFiles.map((f) => `${f} (non-Rust or documentation file skipped)`),
        ],
        failedCohorts: [],
        clippyDiagnostics,
        securityAdvisories,
        generatedAt: analyzeContext.generatedAt,
      });

      const [learnings, repoInstructions] = await Promise.all([
        new LearningStore(repoRoot).getMatchingLearnings(
          modifiedFiles,
          pr.baseSha,
          peerConfig.rules,
        ),
        loadRepoInstructions(repoRoot, pr.baseSha),
      ]);
      const cohorts = planAllSubsystemCohorts(diffMap, crateGraph);
      const reviewCtx = {
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
        repoInstructions,
        cohorts,
        auditLogger,
      };
      const promptContextMd = buildReviewContextPrompt(reviewCtx);
      const cohortPrompts = cohorts.map((cohort) => ({
        id: cohort.id,
        label: cohort.label,
        filePaths: cohort.filePaths,
        markdown: buildCohortContextPrompt(reviewCtx, cohort),
      }));

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
        skippedTools,
        toolOutcomes,
        configHash,
        symbolGraph,
        promptContextMd,
        cohortPrompts,
        extraToolOutputs,
      });
    },
  );

  if (!analyzeContext || !analyzeBundle) {
    throw new Error("Internal error: Stage 1 (analyze) produced no context.");
  }

  return {
    analyzeContext,
    analyzeBundle,
    skippedTools,
    toolOutcomes,
    symbolGraph,
    cargoLockDiff,
    geigerReport,
    semverViolations,
    coverageReport,
    miriReport,
  };
}
