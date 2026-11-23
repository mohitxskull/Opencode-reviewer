import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  type AnalyzeStageContext,
  AnalyzeStageContextSchema,
  computeFindingFingerprint,
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
  LensOutputParseError,
  parseLensFindingsWithWarnings,
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
  readonly noCheckout?: boolean;
  readonly profile: ReviewProfile;
  readonly configHash?: string;
  readonly runStartMs: number;
  readonly auditLogger: AuditLogger;
}

export interface FinalizeStageResult {
  readonly bundle: ReviewBundle;
  readonly warnings: string[];
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
  let parsedWalkthrough = false;
  try {
    walkthrough = parseWalkthroughOutput(rawText);
    parsedWalkthrough = true;
  } catch {
    // Walkthrough section is optional when agent only submits findings
  }

  let parsedFindings: ReturnType<typeof parseLensFindingsWithWarnings>;
  try {
    parsedFindings = parseLensFindingsWithWarnings(rawText);
  } catch (err) {
    // Allow standalone walkthrough.md files inside `--from <dir>` that have no `## FINDINGS` section
    if (parsedWalkthrough && err instanceof LensOutputParseError) {
      return {
        walkthrough,
        findings: [],
        consideredAndRejected: [],
        deletionsProposed: [],
        openQuestions: [],
        warnings: [],
      };
    }
    throw err;
  }

  const findings: Finding[] = parsedFindings.output.findings.map((f) => {
    const fp = computeFindingFingerprint(f);
    const inferredSource = f.type === "Idioms" || f.type === "Refactor" ? "idioms" : "soundness";
    return FindingSchema.parse({
      ...f,
      id: `fp-${fp}`,
      suggestionVerified: false,
      source: inferredSource,
    });
  });
  return {
    walkthrough,
    findings,
    consideredAndRejected: parsedFindings.output.consideredAndRejected,
    deletionsProposed: parsedFindings.output.deletionsProposed,
    openQuestions: parsedFindings.output.openQuestions,
    warnings: parsedFindings.warnings,
  };
}

async function resolveAgentInputFiles(fromSpec: string): Promise<string[]> {
  const parts = fromSpec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const files: string[] = [];

  for (const part of parts) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(part);
    } catch {
      throw new Error(`Input review file or directory not found: ${part}`);
    }

    if (info.isDirectory()) {
      const entries = (await readdir(part))
        .filter((name) => name.endsWith(".md") || name.endsWith(".json"))
        .sort((a, b) => a.localeCompare(b));
      if (entries.length === 0) {
        throw new Error(`No .md or .json review files found in directory: ${part}`);
      }
      for (const name of entries) {
        files.push(join(part, name));
      }
    } else {
      files.push(part);
    }
  }

  return files;
}

export async function runFinalizeStage(input: FinalizeStageInput): Promise<FinalizeStageResult> {
  const {
    repoRoot,
    commitDir,
    fromPath,
    verdictsPath,
    stage,
    strict = false,
    noCheckout = false,
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
    throw new Error("`peer finalize` requires `--from <file|dir>` or `--verdicts <file>`.");
  }

  const inputPaths = await resolveAgentInputFiles(fromPath);
  let mergedWalkthrough = analyzeBundle.walkthrough;
  let walkthroughOverridden = false;
  const mergedFindings: Finding[] = [];
  const mergedConsidered: ConsideredAndRejectedItem[] = [];
  const mergedDeletions: DeletionProposedItem[] = [];
  const mergedQuestions: OpenQuestionItem[] = [];
  const mergedWarnings: string[] = [];

  for (const filePath of inputPaths) {
    const rawText = await Bun.file(filePath).text();
    const parsed = parseAgentReviewInput(rawText, analyzeBundle.walkthrough);
    if (!walkthroughOverridden && parsed.walkthrough !== analyzeBundle.walkthrough) {
      mergedWalkthrough = parsed.walkthrough;
      walkthroughOverridden = true;
    }
    mergedFindings.push(...parsed.findings);
    mergedConsidered.push(...parsed.consideredAndRejected);
    mergedDeletions.push(...parsed.deletionsProposed);
    mergedQuestions.push(...parsed.openQuestions);
    for (const w of parsed.warnings) {
      mergedWarnings.push(inputPaths.length > 1 ? `[${filePath}] ${w}` : w);
    }
  }

  const agentReview = {
    walkthrough: mergedWalkthrough,
    findings: mergedFindings,
    consideredAndRejected: mergedConsidered,
    deletionsProposed: mergedDeletions,
    openQuestions: mergedQuestions,
    warnings: mergedWarnings,
  };

  if (strict && agentReview.warnings.length > 0) {
    throw new Error(`Strict mode failed:\n- ${agentReview.warnings.join("\n- ")}`);
  }

  const bundle = await withInPlaceCheckout(
    {
      repoRoot,
      targetSha: analyzeContext.headSha,
      prNumber: analyzeContext.pr.number,
      noCheckout,
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

      const baselineErrorCount = analyzeContext.clippyDiagnostics.filter(
        (d) => d.level === "error",
      ).length;
      const verifier = new SuggestionCompilerVerifier();
      const verifiedInline = await verifier.verifySuggestions(
        repoRoot,
        partitioned.inlineFindings,
        auditLogger,
        {
          crateGraph: analyzeContext.crateGraph,
          baselineErrorCount,
        },
      );

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
