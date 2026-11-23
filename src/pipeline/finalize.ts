import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

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
  type MalformedFindingDiagnostic,
  parseLensFindingsWithWarnings,
  parseSkepticVerdicts,
  parseWalkthroughOutput,
} from "../llm/parser.ts";
import {
  loadJsonIfExists,
  loadRawJsonIfExists,
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

export interface VerdictReconciliation {
  readonly beforeCount: number;
  readonly verdictsApplied: number;
  readonly keptCount: number;
  readonly droppedCount: number;
  readonly droppedIds: readonly string[];
  readonly lockedRetainedIds: readonly string[];
  readonly unmatchedVerdictIds: readonly string[];
}

export interface CohortCoverageReport {
  readonly expectedCohortIds: readonly string[];
  readonly matchedCohortIds: readonly string[];
  readonly missingCohortIds: readonly string[];
  readonly extraFiles: readonly string[];
}

export interface FileMalformedFindingDiagnostic extends MalformedFindingDiagnostic {
  readonly file: string;
}

export interface FinalizeStageResult {
  readonly bundle: ReviewBundle;
  readonly warnings: string[];
  readonly malformedBlocks?: readonly FileMalformedFindingDiagnostic[];
  readonly verdictSummary?: string;
  readonly reconciliation?: VerdictReconciliation;
  readonly cohortCoverage?: CohortCoverageReport;
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
  malformedBlocks: MalformedFindingDiagnostic[];
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
        malformedBlocks: [],
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
    malformedBlocks: parsedFindings.malformedBlocks,
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
    const verdictFiles = await resolveAgentInputFiles(verdictsPath);
    const rawVerdictChunks: string[] = [];
    for (const vf of verdictFiles) {
      rawVerdictChunks.push(await Bun.file(vf).text());
    }
    const rawVerdicts = rawVerdictChunks.join("\n\n");
    const verdictMap = parseSkepticVerdicts(rawVerdicts);
    const warnings: string[] = [];

    if (verdictMap.size === 0) {
      warnings.push("No valid skeptic verdicts were parsed from the verdicts file.");
      if (strict) {
        throw new Error(`Strict mode failed: ${warnings.join(" ")}`);
      }
    }

    const refutedItems: ConsideredAndRejectedItem[] = [];
    const droppedIds: string[] = [];
    const lockedDropIgnoredIds: string[] = [];
    const matchedIds = new Set<string>();
    const beforeCount =
      reviewBundle.findings.length + (reviewBundle.outsideDiffFindings?.length ?? 0);

    const filterList = (list: readonly Finding[]): Finding[] => {
      const kept: Finding[] = [];
      for (const f of list) {
        const v = verdictMap.get(f.id);
        if (v) {
          matchedIds.add(f.id);
        }
        // Why: Hard compiler diagnostics (`clippy`) and CVE/sensitive-file findings (`audit` excluding
        // heuristic `audit-ast-*` detectors) are non-refutable ground truth. Heuristic AST panic/unsafe
        // findings (`audit-ast-*`) CAN be refuted by the skeptic when guarded by invariants.
        const isLockedGroundTruth =
          f.source === "clippy" || (f.source === "audit" && !f.id.startsWith("audit-ast-"));
        if (isLockedGroundTruth) {
          if (v && !v.keep) {
            lockedDropIgnoredIds.push(f.id);
          }
          kept.push(f);
          continue;
        }
        if (v && !v.keep) {
          droppedIds.push(f.id);
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

    const keptCount =
      updatedBundle.findings.length + (updatedBundle.outsideDiffFindings?.length ?? 0);
    const unmatchedVerdictIds = Array.from(verdictMap.keys()).filter((id) => !matchedIds.has(id));
    if (lockedDropIgnoredIds.length > 0) {
      warnings.push(
        `Ignored DROP verdict on ${lockedDropIgnoredIds.length} non-refutable compiler/CVE finding(s): ${lockedDropIgnoredIds.join(", ")}`,
      );
    }
    if (unmatchedVerdictIds.length > 0) {
      warnings.push(
        `${unmatchedVerdictIds.length} verdict ID(s) did not match any Stage 2 finding: ${unmatchedVerdictIds.join(", ")}`,
      );
    }

    const summaryParts = [
      `Before: ${beforeCount} -> Kept: ${keptCount} | Dropped: ${droppedIds.length}${
        droppedIds.length > 0 ? ` (${droppedIds.join(", ")})` : ""
      }`,
    ];
    if (lockedDropIgnoredIds.length > 0) {
      summaryParts.push(`Locked ground-truth retained: ${lockedDropIgnoredIds.join(", ")}`);
    }
    if (unmatchedVerdictIds.length > 0) {
      summaryParts.push(`Unmatched verdict IDs: ${unmatchedVerdictIds.join(", ")}`);
    }
    const verdictSummary = summaryParts.join("\n  ");

    const reconciliation: VerdictReconciliation = {
      beforeCount,
      verdictsApplied: verdictMap.size,
      keptCount,
      droppedCount: droppedIds.length,
      droppedIds,
      lockedRetainedIds: lockedDropIgnoredIds,
      unmatchedVerdictIds,
    };

    await writeVerifyStageArtifacts(
      repoRoot,
      updatedBundle,
      {
        keptCount,
        refutedItems,
      },
      {
        model: "external-agent",
        configHash,
        durationMs: Date.now() - runStartMs,
      },
    );

    return { bundle: updatedBundle, warnings, verdictSummary, reconciliation };
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
  const cohortIndex = await loadRawJsonIfExists<Array<{ id: string }>>(
    join(commitDir, "01-analyze", "cohorts", "index.json"),
  );
  const expectedCohortIds = (cohortIndex ?? []).map((c) => c.id);
  const expectedSet = new Set(expectedCohortIds);
  const matchedCohortIds: string[] = [];
  const extraFiles: string[] = [];

  for (const fp of inputPaths) {
    const stem = basename(fp).replace(/\.(md|json)$/i, "");
    if (expectedSet.has(stem)) {
      matchedCohortIds.push(stem);
    } else if (stem !== "walkthrough") {
      extraFiles.push(basename(fp));
    }
  }
  const matchedSet = new Set(matchedCohortIds);
  const missingCohortIds = expectedCohortIds.filter((id) => !matchedSet.has(id));
  const cohortCoverage: CohortCoverageReport = {
    expectedCohortIds,
    matchedCohortIds,
    missingCohortIds,
    extraFiles,
  };

  let mergedWalkthrough = analyzeBundle.walkthrough;
  let walkthroughOverridden = false;
  const mergedFindings: Finding[] = [];
  const mergedConsidered: ConsideredAndRejectedItem[] = [];
  const mergedDeletions: DeletionProposedItem[] = [];
  const mergedQuestions: OpenQuestionItem[] = [];
  const mergedWarnings: string[] = [];
  const mergedMalformed: FileMalformedFindingDiagnostic[] = [];

  // When cohort-named files (`peer-cohort-*` or `cohort-*`) are submitted and some cohorts from `01-analyze/cohorts/index.json`
  // are missing, warn (and fail in --strict mode) so the orchestrator agent self-heals instead of silently dropping cohorts.
  if (matchedCohortIds.length > 0 && missingCohortIds.length > 0) {
    mergedWarnings.push(
      `Missing ${missingCohortIds.length} expected cohort review file(s): ${missingCohortIds.join(", ")}`,
    );
  }

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
    for (const m of parsed.malformedBlocks) {
      mergedMalformed.push({ ...m, file: filePath });
    }
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
        failedCohorts: matchedCohortIds.length > 0 ? missingCohortIds : [],
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

  return {
    bundle,
    warnings: agentReview.warnings,
    malformedBlocks: mergedMalformed,
    cohortCoverage,
  };
}
