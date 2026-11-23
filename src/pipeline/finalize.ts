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
import {
  parseLensFindingsOutput,
  parseSkepticVerdicts,
  parseWalkthroughOutput,
} from "../llm/parser.ts";
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
  readonly fromPath?: string;
  readonly verdictsPath?: string;
  readonly stage: "review" | "verify";
  readonly strict?: boolean;
  readonly profile: ReviewProfile;
  readonly configHash?: string;
  readonly runStartMs: number;
  readonly auditLogger: AuditLogger;
}

export interface FinalizeStageResult {
  readonly bundle: ReviewBundle;
  readonly warnings: string[];
}

function collectMarkdownParseWarnings(rawText: string, parsedCount: number): string[] {
  const warnings: string[] = [];
  const blockMatches = rawText.match(/^###\s+FINDING\b/gim) ?? [];
  if (blockMatches.length > parsedCount) {
    warnings.push(
      `Dropped ${blockMatches.length - parsedCount} malformed ### FINDING block(s) out of ${blockMatches.length} (check required File/Lines/Title/Body fields).`,
    );
  }
  const sevLines = rawText.match(/^-\s*Severity\s*:\s*(.+)$/gim) ?? [];
  const validSevs = new Set(["critical", "major", "minor", "trivial", "info", "none"]);
  for (const line of sevLines) {
    const rawSev = line.split(":").slice(1).join(":").trim().toLowerCase();
    if (rawSev && !validSevs.has(rawSev)) {
      warnings.push(`Unknown severity "${rawSev}" coerced to Minor.`);
    }
  }
  return warnings;
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
  warnings: string[];
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
  const warnings = collectMarkdownParseWarnings(rawText, findings.length);
  return {
    walkthrough,
    findings,
    consideredAndRejected: parsedFindings.consideredAndRejected,
    deletionsProposed: parsedFindings.deletionsProposed,
    openQuestions: parsedFindings.openQuestions,
    warnings,
  };
}

export async function runFinalizeStage(input: FinalizeStageInput): Promise<FinalizeStageResult> {
  const {
    repoRoot,
    commitDir,
    fromPath,
    verdictsPath,
    stage,
    strict = false,
    profile,
    configHash = "default",
    runStartMs,
    auditLogger,
  } = input;

  // Deterministic Stage 3 skeptic verdicts mode (`peer finalize --verdicts <file>`)
  if (verdictsPath) {
    const reviewBundle = await loadJsonIfExists(
      join(commitDir, "02-review", "bundle.json"),
      ReviewBundleSchema,
    );
    if (!reviewBundle) {
      throw new Error(
        `No Stage 2 (review) bundle found in ${join(commitDir, "02-review", "bundle.json")}. Run \`peer finalize --from <file>\` first.`,
      );
    }
    const verdictsFile = Bun.file(verdictsPath);
    if (!(await verdictsFile.exists())) {
      throw new Error(`Verdicts file not found: ${verdictsPath}`);
    }
    const rawVerdicts = await verdictsFile.text();
    const verdictMap = parseSkepticVerdicts(rawVerdicts);
    const warnings: string[] = [];

    if (verdictMap.size === 0) {
      warnings.push("No valid skeptic verdicts were parsed from the verdicts file.");
      if (strict) {
        throw new Error(`Strict mode failed: ${warnings.join(" ")}`);
      }
    }

    const refutedItems: ConsideredAndRejectedItem[] = [];
    const filterList = (list: readonly Finding[]): Finding[] => {
      const kept: Finding[] = [];
      for (const f of list) {
        // Deterministic compiler/audit findings are ground truth and never refuted by LLM skeptic
        if (f.source === "clippy" || f.source === "audit") {
          kept.push(f);
          continue;
        }
        const v = verdictMap.get(f.id);
        if (v && !v.keep) {
          refutedItems.push({
            location: `${f.filePath}:${f.startLine}`,
            hypothesis: f.title,
            reasonDismissed: v.reason || "Refuted by skeptic pass",
          });
        } else {
          kept.push(f);
        }
      }
      return kept;
    };

    const updatedBundle = ReviewBundleSchema.parse({
      ...reviewBundle,
      findings: filterList(reviewBundle.findings),
      outsideDiffFindings: filterList(reviewBundle.outsideDiffFindings ?? []),
      consideredAndRejected: [...(reviewBundle.consideredAndRejected ?? []), ...refutedItems],
      generatedAt: new Date().toISOString(),
    });

    await writeVerifyStageArtifacts(
      repoRoot,
      updatedBundle,
      {
        keptCount: updatedBundle.findings.length + (updatedBundle.outsideDiffFindings?.length ?? 0),
        refutedItems,
      },
      {
        model: "external-agent",
        configHash,
        durationMs: Date.now() - runStartMs,
      },
    );

    return { bundle: updatedBundle, warnings };
  }

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

  if (!fromPath) {
    throw new Error("`peer finalize` requires `--from <file>` or `--verdicts <file>`.");
  }

  const inputFile = Bun.file(fromPath);
  if (!(await inputFile.exists())) {
    throw new Error(`Input review file not found: ${fromPath}`);
  }
  const rawAgentOutput = await inputFile.text();
  const agentReview = parseAgentReviewInput(rawAgentOutput, analyzeBundle.walkthrough);

  if (strict && agentReview.warnings.length > 0) {
    throw new Error(`Strict mode failed:\n- ${agentReview.warnings.join("\n- ")}`);
  }

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
        notReviewed: analyzeBundle.notReviewed ?? [],
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
        configHash,
        durationMs: Date.now() - runStartMs,
        enabledTools: analyzeContext.enabledTools,
      },
    );
  } else {
    await writeReviewStageArtifacts(repoRoot, bundle, {
      model: "external-agent",
      configHash,
      durationMs: Date.now() - runStartMs,
      enabledTools: analyzeContext.enabledTools,
    });
  }

  return { bundle, warnings: agentReview.warnings };
}
