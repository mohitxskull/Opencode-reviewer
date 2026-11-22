import { z } from "zod";

// Why: GitHub's multi-line PR review comment API (start_line..line on side="RIGHT")
// rejects comments whose start_line and line belong to different diff hunks with
// 422 Unprocessable Entity. Requiring both lines to reside inside the same DiffHunk
// guarantees every surviving inline finding and ```suggestion``` block can be
// anchored and committed on GitHub.
export const CHILL_MINOR_MIN_CONFIDENCE = 0.8;
export const WALKTHROUGH_MARKER = "<!-- peer-walkthrough-comment -->";

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

export const FindingSourceSchema = z.enum(["clippy", "soundness", "idioms"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

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
    title: z.string().min(1),
    body: z.string().min(1),
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
    z.object({
      filePath: z.string().min(1),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      severity: SeveritySchema,
      type: FindingTypeSchema,
      title: z.string().min(1),
      body: z.string().min(1),
      suggestion: z.string().nullable().default(null),
      agentPrompt: z.string().min(1),
      confidence: z.number().min(0).max(1).default(0.9),
    }),
  ),
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

export const PullRequestSummarySchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  author: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headSha: z.string().min(7),
  baseSha: z.string().min(7),
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
  baseSha: z.string().min(7),
  lastReviewedHeadSha: z.string().min(7),
  reviewedAt: z.string(),
  profile: ReviewProfileSchema,
});
export type ReviewCheckpoint = z.infer<typeof ReviewCheckpointSchema>;

export const ReviewBundleSchema = z.object({
  pr: PullRequestMetadataSchema,
  diffBaseSha: z.string().min(7),
  headSha: z.string().min(7),
  isIncremental: z.boolean(),
  profile: ReviewProfileSchema,
  walkthrough: WalkthroughReportSchema,
  findings: z.array(FindingSchema),
  clippyDiagnostics: z.array(ClippyDiagnosticSchema),
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
