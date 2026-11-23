import { join } from "node:path";

import {
  type AnalyzeStageContext,
  AnalyzeStageContextSchema,
  type ConsideredAndRejectedItem,
  type DeletionProposedItem,
  type Finding,
  FindingSchema,
  type OpenQuestionItem,
  type ReviewBundle,
  ReviewBundleSchema,
  type ReviewProfile,
  type WalkthroughReport,
} from "../domain/models.ts";
import { partitionAndFilterFindings } from "../judge/partition.ts";
import { SuggestionCompilerVerifier } from "../judge/verifier.ts";
import { parseLensFindingsOutput, parseWalkthroughOutput } from "../llm/parser.ts";
import {
  loadJsonIfExists,
  writeReviewStageArtifacts,
  writeVerifyStageArtifacts,
} from "../workspace/artifacts.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";
import { withInPlaceCheckout } from "../workspace/git.ts";

export interface FinalizeStageInput {
  readonly repoRoot: string;
  readonly commitDir: string;
  readonly fromPath: string;
  readonly stage: "review" | "verify";
  readonly profile: ReviewProfile;
  readonly runStartMs: number;
  readonly auditLogger: AuditLogger;
}

function parseAgentReviewInput(
  rawText: string,
  fallbackWalkthrough: WalkthroughReport,
): {
  walkthrough: WalkthroughReport;
  findings: Finding[];
  consideredAndRejected: ConsideredAndRejectedItem[];
  deletionsProposed: DeletionProposedItem[];
  openQuestions: OpenQuestionItem[];
} {
  let walkthrough = fallbackWalkthrough;
  try {
    walkthrough = parseWalkthroughOutput(rawText);
  } catch {
    // Walkthrough section is optional when agent only submits findings
  }

  const parsedFindings = parseLensFindingsOutput(rawText);
  const findings: Finding[] = parsedFindings.findings.map((f, idx) =>
    FindingSchema.parse({
      ...f,
      id: `agent-${idx + 1}`,
      suggestionVerified: false,
      source: "soundness",
    }),
  );
  return {
    walkthrough,
    findings,
    consideredAndRejected: parsedFindings.consideredAndRejected,
    deletionsProposed: parsedFindings.deletionsProposed,
    openQuestions: parsedFindings.openQuestions,
  };
}

export async function runFinalizeStage(input: FinalizeStageInput): Promise<ReviewBundle> {
  const { repoRoot, commitDir, fromPath, stage, profile, runStartMs, auditLogger } = input;

  const analyzeContext: AnalyzeStageContext | null = await loadJsonIfExists(
    join(commitDir, "01-analyze", "context.json"),
    AnalyzeStageContextSchema,
  );
  const analyzeBundle: ReviewBundle | null = await loadJsonIfExists(
    join(commitDir, "01-analyze", "bundle.json"),
    ReviewBundleSchema,
  );

  if (!analyzeContext || !analyzeBundle) {
    throw new Error(
      `No Stage 1 (analyze) artifacts found in ${join(commitDir, "01-analyze")}. Run \`peer analyze\` first.`,
    );
  }

  const inputFile = Bun.file(fromPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input review file not found: ${fromPath}`);
  }
  const rawAgentOutput = await inputFile.text();
  const agentReview = parseAgentReviewInput(rawAgentOutput, analyzeBundle.walkthrough);

  const bundle = await withInPlaceCheckout(
    {
      repoRoot,
      targetSha: analyzeContext.headSha,
      prNumber: analyzeContext.pr.number,
    },
    async () => {
      await auditLogger.logEvent(
        "stage.finalize.started",
        `▶ Finalizing agent review (${agentReview.findings.length} agent finding(s) + ${analyzeContext.deterministicFindings.length} deterministic finding(s)) and verifying suggestions with cargo check...`,
      );

      const partitioned = partitionAndFilterFindings(
        [...analyzeContext.deterministicFindings, ...agentReview.findings],
        analyzeContext.diffMap,
        profile,
      );

      const hasBaselineCompileErrors = analyzeContext.clippyDiagnostics.some(
        (d) => d.level === "error",
      );
      const verifier = new SuggestionCompilerVerifier();
      const verifiedInline = hasBaselineCompileErrors
        ? partitioned.inlineFindings
        : await verifier.verifySuggestions(repoRoot, partitioned.inlineFindings, auditLogger);

      const existingDeletionRefs = new Set(
        agentReview.deletionsProposed.map((d) => d.pathOrSymbol),
      );
      const rustcDeadCodeDeletions: DeletionProposedItem[] = analyzeContext.clippyDiagnostics
        .filter((d) => d.code === "dead_code")
        .map((d) => ({
          pathOrSymbol: `${d.filePath}:${d.startLine}`,
          reachabilityEvidence: `rustc dead_code diagnostic: ${d.message}`,
          replacement: "Remove dead symbol or wire into production caller",
        }))
        .filter((d) => !existingDeletionRefs.has(d.pathOrSymbol));

      return ReviewBundleSchema.parse({
        pr: analyzeContext.pr,
        diffBaseSha: analyzeContext.diffBaseSha,
        headSha: analyzeContext.headSha,
        isIncremental: analyzeContext.isIncremental,
        profile,
        baseline: analyzeContext.baseline,
        walkthrough: agentReview.walkthrough,
        findings: verifiedInline,
        outsideDiffFindings: partitioned.outsideDiffFindings,
        nitpickFindings: partitioned.nitpickFindings,
        consideredAndRejected: agentReview.consideredAndRejected,
        deletionsProposed: [...agentReview.deletionsProposed, ...rustcDeadCodeDeletions],
        openQuestions: agentReview.openQuestions,
        notReviewed: analyzeContext.excludedFiles.map(
          (f) => `${f} (non-Rust or documentation file skipped)`,
        ),
        failedCohorts: [],
        clippyDiagnostics: analyzeContext.clippyDiagnostics,
        securityAdvisories: analyzeContext.securityAdvisories,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  if (stage === "verify") {
    await writeVerifyStageArtifacts(
      repoRoot,
      bundle,
      {
        keptCount: bundle.findings.length + (bundle.outsideDiffFindings?.length ?? 0),
        refutedItems: bundle.consideredAndRejected ?? [],
      },
      {
        model: "external-agent",
        durationMs: Date.now() - runStartMs,
        enabledTools: analyzeContext.enabledTools,
      },
    );
  } else {
    await writeReviewStageArtifacts(repoRoot, bundle, {
      model: "external-agent",
      durationMs: Date.now() - runStartMs,
      enabledTools: analyzeContext.enabledTools,
    });
  }

  return bundle;
}
