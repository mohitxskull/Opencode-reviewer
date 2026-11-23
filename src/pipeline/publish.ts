import { join, resolve } from "node:path";

import {
  AnalyzeStageContextSchema,
  type PipelineStage,
  type PullRequestMetadata,
  type ReviewBundle,
  ReviewBundleSchema,
  type RunManifest,
} from "../domain/models.ts";
import type { GitHubClient, InlineReviewCommentInput } from "../github/client.ts";
import {
  renderInlineFindingComment,
  renderPrReviewSummaryBody,
  renderWalkthroughComment,
} from "../render/markdown.ts";
import { loadJsonIfExists, writePublishStageArtifacts } from "../workspace/artifacts.ts";
import type { CheckpointStore } from "../workspace/git.ts";

export interface PublishStageInput {
  readonly repoRoot: string;
  readonly commitDir: string;
  readonly owner: string;
  readonly repo: string;
  readonly pr: PullRequestMetadata;
  readonly submitReview: boolean;
  readonly allowPartial: boolean;
  readonly modelLabel: string;
  readonly enabledToolsList: readonly string[];
  readonly runStartMs: number;
  readonly existingManifest: RunManifest | null;
  readonly githubClient: GitHubClient;
  readonly checkpointStore: CheckpointStore;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
}

export async function runPublishStage(input: PublishStageInput): Promise<number> {
  const {
    repoRoot,
    commitDir,
    owner,
    repo,
    pr,
    submitReview,
    allowPartial,
    modelLabel,
    enabledToolsList,
    runStartMs,
    existingManifest,
    githubClient,
    checkpointStore,
    writeOut,
    writeErr,
  } = input;

  const verifyBundle = await loadJsonIfExists(
    join(commitDir, "03-verify", "bundle.json"),
    ReviewBundleSchema,
  );
  const reviewBundle = await loadJsonIfExists(
    join(commitDir, "02-review", "bundle.json"),
    ReviewBundleSchema,
  );
  const analyzeBundle = await loadJsonIfExists(
    join(commitDir, "01-analyze", "bundle.json"),
    ReviewBundleSchema,
  );
  const analyzeContext = await loadJsonIfExists(
    join(commitDir, "01-analyze", "context.json"),
    AnalyzeStageContextSchema,
  );

  let sourceStage: PipelineStage | null = null;
  let bundleToPublish: ReviewBundle | null = null;
  if (verifyBundle) {
    sourceStage = "verify";
    bundleToPublish = verifyBundle;
  } else if (reviewBundle) {
    sourceStage = "review";
    bundleToPublish = reviewBundle;
  } else if (analyzeBundle) {
    sourceStage = "analyze";
    bundleToPublish = analyzeBundle;
  }

  if (!bundleToPublish || !sourceStage || !analyzeContext) {
    writeErr(
      `No local review artifacts found for PR #${pr.number} @ ${pr.headSha.slice(0, 7)}. Run \`peer analyze ${pr.number}\`, \`peer review ${pr.number}\`, or \`peer verify ${pr.number}\` first.`,
    );
    return 1;
  }

  const failedCohorts = bundleToPublish.failedCohorts ?? [];
  if (failedCohorts.length > 0 && !allowPartial) {
    writeErr(
      `Error: ${failedCohorts.length} review cohort(s) failed (${failedCohorts.join(", ")}). Refusing to publish partial review. Pass --allow-partial to override.`,
    );
    return 2;
  }

  const walkthroughCommentBody = renderWalkthroughComment(bundleToPublish);
  await githubClient.upsertWalkthroughComment(owner, repo, pr.number, walkthroughCommentBody);

  const inlineComments: InlineReviewCommentInput[] = bundleToPublish.findings.map((finding) => ({
    path: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    body: renderInlineFindingComment(finding),
  }));

  await githubClient.postPrReview({
    owner,
    repo,
    prNumber: pr.number,
    commitId: pr.headSha,
    comments: inlineComments,
    diffMap: analyzeContext.activeDiffMap,
    submit: submitReview,
    summaryBody: renderPrReviewSummaryBody(bundleToPublish),
  });

  await checkpointStore.save({
    prNumber: pr.number,
    baseSha: pr.baseSha,
    lastReviewedHeadSha: pr.headSha,
    reviewedAt: new Date().toISOString(),
    profile: bundleToPublish.profile,
  });

  const existingStages = existingManifest?.completedStages ?? [sourceStage];
  await writePublishStageArtifacts(
    repoRoot,
    bundleToPublish,
    {
      sourceStage,
      submitted: submitReview,
      inlineCommentsCount: inlineComments.length,
    },
    existingStages,
    {
      model: existingManifest?.model ?? modelLabel,
      durationMs: Date.now() - runStartMs,
      enabledTools: existingManifest?.enabledTools ?? enabledToolsList,
    },
  );

  writeOut(
    `Published PR #${pr.number} @ ${pr.headSha.slice(0, 7)} from stage \`${sourceStage}\` (${inlineComments.length} inline comment(s), mode=${submitReview ? "COMMENT" : "PENDING"}).\nReceipt: file://${resolve(commitDir, "04-publish", "report.md")}`,
  );
  return 0;
}
