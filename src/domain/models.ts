import { z } from "zod";

import packageJson from "../../package.json";

export class AnalyzerExecutionError extends Error {
  readonly tool: string;
  readonly exitCode: number;
  readonly timedOut: boolean;

  constructor(tool: string, exitCode: number, stderr: string, timedOut = false) {
    const snippet = stderr.trim().slice(0, 400) || "(no stderr)";
    super(
      timedOut
        ? `\`${tool}\` timed out: ${snippet}`
        : `\`${tool}\` exited with code ${exitCode} without valid output: ${snippet}`,
    );
    this.name = "AnalyzerExecutionError";
    this.tool = tool;
    this.exitCode = exitCode;
    this.timedOut = timedOut;
  }
}

// Why: GitHub's multi-line PR review comment API (start_line..line on side="RIGHT")
// rejects comments whose start_line and line belong to different diff hunks with
// 422 Unprocessable Entity. Requiring both lines to reside inside the same DiffHunk
// guarantees every surviving inline finding and ```suggestion``` block can be
// anchored and committed on GitHub.
export const CHILL_MINOR_MIN_CONFIDENCE = 0.8;
export const WALKTHROUGH_MARKER = "<!-- peer-walkthrough-comment -->";
export const PEER_REVIEW_MARKER = "<!-- peer-review-body -->";

export const GitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "Invalid git commit SHA (expected 7-40 hex chars)");

export const GitRefNameSchema = z
  .string()
  .min(1)
  .refine(
    (s) => !s.startsWith("-") && !s.includes("..") && !/[\s\0~^:?*[\\]/.test(s),
    "Unsafe git ref name",
  );

export const SeveritySchema = z.enum(["Critical", "Major", "Minor", "Trivial", "Info", "None"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  Critical: 0,
  Major: 1,
  Minor: 2,
  Trivial: 3,
  Info: 4,
  None: 5,
};

export const FindingTypeSchema = z.enum([
  "Bug",
  "Security",
  "Soundness",
  "Concurrency",
  "Performance",
  "Idioms",
  "Refactor",
]);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const ReviewProfileSchema = z.enum(["quiet", "chill", "assertive"]);
export type ReviewProfile = z.infer<typeof ReviewProfileSchema>;

export const FindingSourceSchema = z.enum(["clippy", "audit", "soundness", "idioms"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const EpistemicStateSchema = z.enum([
  "VERIFIED-DEFECT",
  "NEEDS-RUNTIME-VERIFICATION",
  "DESIGN-CONCERN",
  "SYMPTOM-PATCH",
]);
export type EpistemicState = z.infer<typeof EpistemicStateSchema>;

export const EvidenceMechanismSchema = z.enum([
  "Concurrency",
  "Security",
  "Performance",
  "Correctness",
  "Design",
]);
export type EvidenceMechanism = z.infer<typeof EvidenceMechanismSchema>;

export const ConsideredAndRejectedItemSchema = z.object({
  location: z.string().min(1),
  hypothesis: z.string().min(1),
  reasonDismissed: z.string().min(1),
});
export type ConsideredAndRejectedItem = z.infer<typeof ConsideredAndRejectedItemSchema>;

export const DeletionProposedItemSchema = z.object({
  pathOrSymbol: z.string().min(1),
  reachabilityEvidence: z.string().min(1),
  replacement: z.string().min(1),
});
export type DeletionProposedItem = z.infer<typeof DeletionProposedItemSchema>;

export const OpenQuestionItemSchema = z.object({
  location: z.string().min(1),
  question: z.string().min(1),
  impact: z.string().min(1),
});
export type OpenQuestionItem = z.infer<typeof OpenQuestionItemSchema>;

export const ReviewBaselineHeaderSchema = z.object({
  mode: z.enum(["REVIEW", "REMEDIATE", "HYBRID"]).default("REVIEW"),
  rustcVersion: z.string().min(1),
  cargoVersion: z.string().min(1),
  verificationCommands: z.array(z.string()),
});
export type ReviewBaselineHeader = z.infer<typeof ReviewBaselineHeaderSchema>;

export const MergeRiskSchema = z.enum(["Minimal", "Low", "Medium", "High", "Critical"]);
export type MergeRisk = z.infer<typeof MergeRiskSchema>;

export const TriageScoreSchema = z.object({
  reviewEffort: z.number().int().min(1).max(5),
  mergeRisk: MergeRiskSchema,
  rationale: z.string().min(1),
});
export type TriageScore = z.infer<typeof TriageScoreSchema>;

export const WalkthroughChangeEntrySchema = z.object({
  layer: z.number().int().min(0),
  crateName: z.string().min(1),
  filePath: z.string().min(1),
  summary: z.string().min(1),
});
export type WalkthroughChangeEntry = z.infer<typeof WalkthroughChangeEntrySchema>;

export const WalkthroughReportSchema = z.object({
  summary: z.string().min(1),
  changes: z.array(WalkthroughChangeEntrySchema),
  sequenceDiagram: z.string().nullable(),
  triage: TriageScoreSchema,
});
export type WalkthroughReport = z.infer<typeof WalkthroughReportSchema>;

export const FindingSchema = z
  .object({
    id: z.string().min(1),
    filePath: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    severity: SeveritySchema,
    type: FindingTypeSchema,
    epistemicState: EpistemicStateSchema.default("VERIFIED-DEFECT").optional(),
    evidenceMechanism: EvidenceMechanismSchema.default("Correctness").optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    rootCause: z.string().default("").optional(),
    blastRadius: z.string().default("Local module").optional(),
    reversible: z.boolean().default(true).optional(),
    dependsOn: z.string().nullable().default(null).optional(),
    verificationCommand: z
      .string()
      .default("cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings")
      .optional(),
    traceability: z.string().default("").optional(),
    suggestion: z.string().nullable(),
    suggestionVerified: z.boolean().default(false),
    agentPrompt: z.string().min(1),
    confidence: z.number().min(0).max(1),
    source: FindingSourceSchema,
  })
  .refine((val) => val.startLine <= val.endLine, {
    message: "startLine must be less than or equal to endLine",
    path: ["startLine"],
  });
export type Finding = z.infer<typeof FindingSchema>;

export const LensFindingsOutputSchema = z.object({
  findings: z.array(
    z
      .object({
        filePath: z.string().min(1),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
        severity: SeveritySchema,
        type: FindingTypeSchema,
        epistemicState: EpistemicStateSchema.default("VERIFIED-DEFECT"),
        evidenceMechanism: EvidenceMechanismSchema.default("Correctness"),
        title: z.string().min(1),
        body: z.string().min(1),
        rootCause: z.string().default(""),
        blastRadius: z.string().default("Local module"),
        reversible: z.boolean().default(true),
        dependsOn: z.string().nullable().default(null),
        verificationCommand: z
          .string()
          .default(
            "cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings",
          ),
        traceability: z.string().default(""),
        suggestion: z.string().nullable().default(null),
        agentPrompt: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.9),
      })
      .refine((val) => val.startLine <= val.endLine, {
        message: "startLine must be less than or equal to endLine",
        path: ["startLine"],
      }),
  ),
  consideredAndRejected: z.array(ConsideredAndRejectedItemSchema).default([]),
  deletionsProposed: z.array(DeletionProposedItemSchema).default([]),
  openQuestions: z.array(OpenQuestionItemSchema).default([]),
});
export type LensFindingsOutput = z.infer<typeof LensFindingsOutputSchema>;

export const DiffHunkSchema = z.object({
  oldStart: z.number().int().min(0),
  oldCount: z.number().int().min(0),
  newStart: z.number().int().min(1),
  newEnd: z.number().int().min(1),
  header: z.string(),
  annotatedLines: z.array(z.string()),
  rightSideLines: z.array(z.number().int().min(1)),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileMapSchema = z.object({
  filePath: z.string().min(1),
  hunks: z.array(DiffHunkSchema),
});
export type DiffFileMap = z.infer<typeof DiffFileMapSchema>;

export const CrateLayerInfoSchema = z.object({
  name: z.string().min(1),
  manifestDir: z.string(),
  layer: z.number().int().min(0),
  dependencies: z.array(z.string()),
});
export type CrateLayerInfo = z.infer<typeof CrateLayerInfoSchema>;

export const CrateGraphSchema = z.object({
  crates: z.record(z.string(), CrateLayerInfoSchema),
  testLayer: z.number().int().min(1),
});
export type CrateGraph = z.infer<typeof CrateGraphSchema>;

export const ClippyDiagnosticSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  level: z.enum(["error", "warning"]),
  code: z.string().nullable(),
  message: z.string().min(1),
  rendered: z.string(),
  suggestedReplacement: z.string().nullable(),
});
export type ClippyDiagnostic = z.infer<typeof ClippyDiagnosticSchema>;

export const SecurityAdvisorySchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  kind: z.enum(["vulnerability", "unsound", "yanked"]),
  title: z.string().min(1),
  description: z.string().default(""),
  url: z.string().nullable().default(null),
  cvss: z.string().nullable().default(null),
  patchedVersions: z.array(z.string()).default([]),
  affectedFunctions: z.array(z.string()).default([]),
  source: z.literal("cargo-audit").default("cargo-audit"),
});
export type SecurityAdvisory = z.infer<typeof SecurityAdvisorySchema>;

export const PullRequestSummarySchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  author: z.string(),
  headRefName: GitRefNameSchema,
  baseRefName: GitRefNameSchema,
  headSha: GitShaSchema,
  baseSha: GitShaSchema,
  htmlUrl: z.string().url(),
  updatedAt: z.string(),
});
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;

export const PullRequestMetadataSchema = PullRequestSummarySchema.extend({
  body: z.string(),
  owner: z.string().min(1),
  repo: z.string().min(1),
});
export type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;

export const ReviewCheckpointSchema = z.object({
  prNumber: z.number().int().min(1),
  baseSha: GitShaSchema,
  lastReviewedHeadSha: GitShaSchema,
  reviewedAt: z.string(),
  profile: ReviewProfileSchema,
});
export type ReviewCheckpoint = z.infer<typeof ReviewCheckpointSchema>;

export const PEER_VERSION: string = packageJson.version;

export const PipelineStageSchema = z.enum(["analyze", "review", "verify", "publish"]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const ToolOutcomeSchema = z.enum(["ok", "skipped", "failed", "timed_out"]);
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolSkipReasonSchema = z.enum([
  "not_enabled",
  "missing_binary",
  "missing_config",
  "no_unsafe_in_diff",
  "no_modified_files",
  "no_dependency_changes",
]);
export type ToolSkipReason = z.infer<typeof ToolSkipReasonSchema>;

export const ToolOutcomeDetailSchema = z.object({
  status: ToolOutcomeSchema,
  findingsCount: z.number().int().min(0).default(0),
  reason: ToolSkipReasonSchema.optional(),
  remediationCommand: z.string().optional(),
});
export type ToolOutcomeDetail = z.infer<typeof ToolOutcomeDetailSchema>;

export const RunManifestSchema = z.object({
  prNumber: z.number().int().min(1),
  headSha: GitShaSchema,
  baseSha: GitShaSchema,
  diffBaseSha: GitShaSchema,
  isIncremental: z.boolean(),
  profile: ReviewProfileSchema,
  model: z.string().min(1),
  peerVersion: z.string(),
  configHash: z.string(),
  status: z.enum(["completed", "partial", "failed"]),
  completedStages: z.array(PipelineStageSchema),
  latestStage: PipelineStageSchema,
  enabledTools: z.array(z.string()).default([]),
  toolOutcomes: z.record(z.string(), ToolOutcomeDetailSchema).default({}),
  failedCohorts: z.array(z.string()).default([]),
  inlineFindingsCount: z.number().int().min(0),
  outsideDiffFindingsCount: z.number().int().min(0),
  nitpickFindingsCount: z.number().int().min(0),
  clippyCount: z.number().int().min(0),
  securityAdvisoriesCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  generatedAt: z.string(),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const AnalyzeStageContextSchema = z.object({
  pr: PullRequestMetadataSchema,
  diffBaseSha: GitShaSchema,
  headSha: GitShaSchema,
  isIncremental: z.boolean(),
  profile: ReviewProfileSchema,
  baseline: ReviewBaselineHeaderSchema,
  crateGraph: CrateGraphSchema,
  diffMap: z.record(z.string(), DiffFileMapSchema),
  activeDiffMap: z.record(z.string(), DiffFileMapSchema),
  excludedFiles: z.array(z.string()),
  clippyDiagnostics: z.array(ClippyDiagnosticSchema),
  securityAdvisories: z.array(SecurityAdvisorySchema),
  enabledTools: z.array(z.string()).default([]),
  configHash: z.string(),
  peerVersion: z.string(),
  deterministicFindings: z.array(FindingSchema).default([]),
  generatedAt: z.string(),
});
export type AnalyzeStageContext = z.infer<typeof AnalyzeStageContextSchema>;

export const ReviewBundleSchema = z.object({
  pr: PullRequestMetadataSchema,
  diffBaseSha: GitShaSchema,
  headSha: GitShaSchema,
  isIncremental: z.boolean(),
  profile: ReviewProfileSchema,
  baseline: ReviewBaselineHeaderSchema.optional(),
  walkthrough: WalkthroughReportSchema,
  findings: z.array(FindingSchema),
  outsideDiffFindings: z.array(FindingSchema).default([]).optional(),
  nitpickFindings: z.array(FindingSchema).default([]).optional(),
  consideredAndRejected: z.array(ConsideredAndRejectedItemSchema).default([]).optional(),
  deletionsProposed: z.array(DeletionProposedItemSchema).default([]).optional(),
  openQuestions: z.array(OpenQuestionItemSchema).default([]).optional(),
  notReviewed: z.array(z.string()).default([]).optional(),
  failedCohorts: z.array(z.string()).default([]).optional(),
  clippyDiagnostics: z.array(ClippyDiagnosticSchema),
  securityAdvisories: z.array(SecurityAdvisorySchema).default([]).optional(),
  generatedAt: z.string(),
});
export type ReviewBundle = z.infer<typeof ReviewBundleSchema>;

export function allowsFindingForProfile(
  profile: ReviewProfile,
  finding: Pick<Finding, "severity" | "confidence">,
): boolean {
  switch (profile) {
    case "quiet":
      return finding.severity === "Critical" || finding.severity === "Major";
    case "chill":
      if (finding.severity === "Critical" || finding.severity === "Major") {
        return true;
      }
      if (finding.severity === "Minor") {
        return finding.confidence >= CHILL_MINOR_MIN_CONFIDENCE;
      }
      return false;
    case "assertive":
      return finding.severity !== "None";
  }
}

export function computeFindingFingerprint(
  finding: Pick<Finding, "filePath" | "type" | "title" | "rootCause"> & {
    readonly symbol?: string;
    readonly snippet?: string;
  },
): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const parts = [
    finding.filePath.replace(/\\/g, "/").replace(/^\.\//, ""),
    finding.type.toLowerCase(),
    finding.symbol ? norm(finding.symbol) : "",
    finding.snippet ? finding.snippet.replace(/\s+/g, " ").trim() : "",
    norm(finding.rootCause || finding.title),
  ].filter(Boolean);
  return new Bun.CryptoHasher("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

export function isValidInlineRange(
  fileMap: DiffFileMap,
  startLine: number,
  endLine: number,
): boolean {
  if (startLine < 1 || startLine > endLine) {
    return false;
  }
  return fileMap.hunks.some((hunk) => startLine >= hunk.newStart && endLine <= hunk.newEnd);
}

export function isOptionalAnalyzerFinding(finding: Pick<Finding, "id">): boolean {
  return /^audit-(?:coverage|semver|geiger|deny|miri)-/.test(finding.id);
}

export function countFindingsByOrigin(findings: readonly Finding[]): {
  readonly substantiveReview: number;
  readonly llmReview: number;
  readonly coreDeterministic: number;
  readonly optionalAnalyzers: number;
} {
  let llmReview = 0;
  let coreDeterministic = 0;
  let optionalAnalyzers = 0;
  for (const f of findings) {
    if (f.source === "soundness" || f.source === "idioms") {
      llmReview += 1;
    } else if (isOptionalAnalyzerFinding(f)) {
      optionalAnalyzers += 1;
    } else {
      coreDeterministic += 1;
    }
  }
  return {
    substantiveReview: llmReview + coreDeterministic,
    llmReview,
    coreDeterministic,
    optionalAnalyzers,
  };
}
