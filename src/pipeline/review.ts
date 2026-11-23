import { join } from "node:path";

import {
  type DeletionProposedItem,
  type ReviewBundle,
  ReviewBundleSchema,
  type ReviewProfile,
  type RunManifest,
} from "../domain/models.ts";
import { partitionAndFilterFindings } from "../judge/partition.ts";
import { SuggestionCompilerVerifier } from "../judge/verifier.ts";
import type { ModelSpec } from "../llm/client.ts";
import type { ReviewContext } from "../llm/context.ts";
import { type MultiLensRunResult, OpenCodeMultiLensOrchestrator } from "../llm/orchestrator.ts";
import { loadJsonIfExists, writeReviewStageArtifacts } from "../workspace/artifacts.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";
import { runGitSync, withInPlaceCheckout } from "../workspace/git.ts";
import type { LearningStore } from "../workspace/learnings.ts";
import type { AnalyzeStageOutput } from "./analyze.ts";

export type LensRunnerFn = (context: ReviewContext) => Promise<MultiLensRunResult>;

export interface ReviewStageInput {
  readonly repoRoot: string;
  readonly commitDir: string;
  readonly profile: ReviewProfile;
  readonly fresh: boolean;
  readonly modelSpec: ModelSpec;
  readonly modelLabel: string;
  readonly concurrencyLimit: number;
  readonly enabledToolsList: readonly string[];
  readonly runStartMs: number;
  readonly existingManifest: RunManifest | null;
  readonly analyzeOut: AnalyzeStageOutput;
  readonly learningStore: LearningStore;
  readonly auditLogger: AuditLogger;
  readonly customLensRunner?: LensRunnerFn;
}

export async function runReviewStage(input: ReviewStageInput): Promise<ReviewBundle> {
  const {
    repoRoot,
    commitDir,
    profile,
    fresh,
    modelSpec,
    modelLabel,
    concurrencyLimit,
    enabledToolsList,
    runStartMs,
    existingManifest,
    analyzeOut,
    learningStore,
    auditLogger,
    customLensRunner,
  } = input;

  const cachedBundle =
    !fresh && existingManifest?.completedStages.includes("review")
      ? await loadJsonIfExists(join(commitDir, "02-review", "bundle.json"), ReviewBundleSchema)
      : null;

  if (cachedBundle) {
    await auditLogger.logEvent(
      "stage.review.reused",
      `▶ Stage 2 (review): Reusing cached LLM review from ${join(commitDir, "02-review")}`,
    );
    return cachedBundle;
  }

  const ctxData = analyzeOut.analyzeContext;
  const modifiedFiles = new Set(Object.keys(ctxData.diffMap));

  if (modifiedFiles.size === 0 && !customLensRunner) {
    await writeReviewStageArtifacts(repoRoot, analyzeOut.analyzeBundle, {
      model: modelLabel,
      durationMs: Date.now() - runStartMs,
      enabledTools: enabledToolsList,
    });
    return analyzeOut.analyzeBundle;
  }

  const reviewBundle = await withInPlaceCheckout(
    { repoRoot, targetSha: ctxData.headSha, prNumber: ctxData.pr.number },
    async () => {
      const learnings = await learningStore.getMatchingLearnings(modifiedFiles, ctxData.pr.baseSha);
      const reviewContext: ReviewContext = {
        repoRoot,
        pr: ctxData.pr,
        diffBaseSha: ctxData.diffBaseSha,
        headSha: ctxData.headSha,
        isIncremental: ctxData.isIncremental,
        fresh,
        crateGraph: ctxData.crateGraph,
        diffMap: ctxData.diffMap,
        clippyDiagnostics: ctxData.clippyDiagnostics,
        securityAdvisories: ctxData.securityAdvisories,
        cargoLockDiff: analyzeOut.cargoLockDiff,
        geigerReport: analyzeOut.geigerReport,
        semverViolations: analyzeOut.semverViolations,
        coverageReport: analyzeOut.coverageReport,
        miriReport: analyzeOut.miriReport,
        symbolGraph: analyzeOut.symbolGraph,
        learnings,
        auditLogger,
      };

      await auditLogger.logEvent(
        "stage.review.started",
        `▶ Stage 2 (review): Running OpenCode review lenses (model: ${modelLabel})...`,
      );

      const lensRunner: LensRunnerFn =
        customLensRunner ??
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

      const hasBaselineCompileErrors = ctxData.clippyDiagnostics.some((d) => d.level === "error");
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
        pr: ctxData.pr,
        diffBaseSha: ctxData.diffBaseSha,
        headSha: ctxData.headSha,
        isIncremental: ctxData.isIncremental,
        profile,
        baseline: ctxData.baseline,
        walkthrough: lensResult.walkthrough,
        findings: verifiedInline,
        outsideDiffFindings: partitioned.outsideDiffFindings,
        nitpickFindings: partitioned.nitpickFindings,
        consideredAndRejected: lensResult.consideredAndRejected ?? [],
        deletionsProposed: [...(lensResult.deletionsProposed ?? []), ...rustcDeadCodeDeletions],
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

  return reviewBundle;
}
