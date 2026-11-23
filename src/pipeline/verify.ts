import {
  type ConsideredAndRejectedItem,
  type Finding,
  type ReviewBundle,
  ReviewBundleSchema,
} from "../domain/models.ts";
import type { ModelSpec } from "../llm/client.ts";
import { OpenCodeMultiLensOrchestrator } from "../llm/orchestrator.ts";
import { writeVerifyStageArtifacts } from "../workspace/artifacts.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";
import { withInPlaceCheckout } from "../workspace/git.ts";

export type SkepticRunnerFn = (
  repoRoot: string,
  candidates: readonly Finding[],
  audit?: AuditLogger,
) => Promise<{ keptFindings: Finding[]; rejectedItems: ConsideredAndRejectedItem[] }>;

export interface VerifyStageInput {
  readonly repoRoot: string;
  readonly reviewBundle: ReviewBundle;
  readonly modelSpec: ModelSpec;
  readonly modelLabel: string;
  readonly concurrencyLimit: number;
  readonly enabledToolsList: readonly string[];
  readonly runStartMs: number;
  readonly auditLogger: AuditLogger;
  readonly customSkepticRunner?: SkepticRunnerFn;
}

export async function runVerifyStage(input: VerifyStageInput): Promise<ReviewBundle> {
  const {
    repoRoot,
    reviewBundle,
    modelSpec,
    modelLabel,
    concurrencyLimit,
    enabledToolsList,
    runStartMs,
    auditLogger,
    customSkepticRunner,
  } = input;

  return await withInPlaceCheckout(
    { repoRoot, targetSha: reviewBundle.headSha, prNumber: reviewBundle.pr.number },
    async () => {
      await auditLogger.logEvent(
        "stage.verify.started",
        `▶ Stage 3 (verify): Running adversarial skeptic pass over Stage 2 findings...`,
      );

      const skepticRunner: SkepticRunnerFn =
        customSkepticRunner ??
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
}
