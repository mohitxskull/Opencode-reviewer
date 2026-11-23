import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { RustSymbolGraph } from "../analyzers/symbol-graph.ts";
import {
  type AnalyzeStageContext,
  type ConsideredAndRejectedItem,
  type PipelineStage,
  type ReviewBundle,
  type RunManifest,
  RunManifestSchema,
} from "../domain/models.ts";
import { renderCombinedLocalReviewMarkdown, renderWalkthroughComment } from "../render/markdown.ts";
import { ensurePeerWorkspaceExcluded, resolvePeerCommitDir } from "./git.ts";

export interface WriteArtifactsMeta {
  readonly model?: string;
  readonly durationMs?: number;
  readonly completedStages?: readonly PipelineStage[];
  readonly latestStage?: PipelineStage;
  readonly enabledTools?: readonly string[];
  readonly symbolGraph?: RustSymbolGraph;
  readonly promptContextMd?: string;
  readonly extraToolOutputs?: Readonly<Record<string, unknown>>;
}

function buildRunManifest(bundle: ReviewBundle, meta: WriteArtifactsMeta): RunManifest {
  const failedCohorts = bundle.failedCohorts ?? [];
  return RunManifestSchema.parse({
    prNumber: bundle.pr.number,
    headSha: bundle.headSha,
    baseSha: bundle.pr.baseSha,
    diffBaseSha: bundle.diffBaseSha,
    isIncremental: bundle.isIncremental,
    profile: bundle.profile,
    model: meta.model ?? "deterministic",
    status: failedCohorts.length > 0 ? "partial" : "completed",
    completedStages: meta.completedStages ?? ["analyze", "review"],
    latestStage: meta.latestStage ?? "review",
    enabledTools: meta.enabledTools ?? [],
    failedCohorts,
    inlineFindingsCount: bundle.findings.length,
    outsideDiffFindingsCount: bundle.outsideDiffFindings?.length ?? 0,
    nitpickFindingsCount: bundle.nitpickFindings?.length ?? 0,
    clippyCount: bundle.clippyDiagnostics.length,
    securityAdvisoriesCount: bundle.securityAdvisories?.length ?? 0,
    durationMs: Math.max(0, Math.round(meta.durationMs ?? 0)),
    generatedAt: bundle.generatedAt,
  });
}

export async function writeAnalyzeStageArtifacts(
  repoRoot: string,
  analyzeContext: AnalyzeStageContext,
  bundle: ReviewBundle,
  meta: WriteArtifactsMeta = {},
): Promise<string> {
  await ensurePeerWorkspaceExcluded(repoRoot);
  const commitDir = resolvePeerCommitDir(repoRoot, bundle.pr.number, bundle.headSha);
  const stageDir = join(commitDir, "01-analyze");
  const toolsDir = join(stageDir, "tools");
  await mkdir(toolsDir, { recursive: true });

  const reportMd = renderCombinedLocalReviewMarkdown(bundle);
  const manifest = buildRunManifest(bundle, {
    ...meta,
    model: meta.model ?? "deterministic",
    completedStages: ["analyze"],
    latestStage: "analyze",
  });

  const writes: Promise<unknown>[] = [
    Bun.write(join(stageDir, "report.md"), reportMd),
    Bun.write(join(stageDir, "context.json"), JSON.stringify(analyzeContext, null, 2)),
    Bun.write(join(stageDir, "bundle.json"), JSON.stringify(bundle, null, 2)),
    Bun.write(join(commitDir, "review.md"), reportMd),
    Bun.write(join(commitDir, "run.json"), JSON.stringify(manifest, null, 2)),
    Bun.write(join(toolsDir, "clippy.json"), JSON.stringify(bundle.clippyDiagnostics, null, 2)),
    Bun.write(
      join(toolsDir, "audit.json"),
      JSON.stringify(bundle.securityAdvisories ?? [], null, 2),
    ),
  ];

  if (meta.promptContextMd) {
    writes.push(Bun.write(join(stageDir, "prompt-context.md"), meta.promptContextMd));
  }
  if (meta.symbolGraph) {
    writes.push(
      Bun.write(join(toolsDir, "symbol-graph.json"), JSON.stringify(meta.symbolGraph, null, 2)),
    );
  }
  if (meta.extraToolOutputs) {
    for (const [toolName, payload] of Object.entries(meta.extraToolOutputs)) {
      writes.push(Bun.write(join(toolsDir, `${toolName}.json`), JSON.stringify(payload, null, 2)));
    }
  }

  await Promise.all(writes);
  return commitDir;
}

export async function writeReviewStageArtifacts(
  repoRoot: string,
  bundle: ReviewBundle,
  meta: WriteArtifactsMeta = {},
): Promise<string> {
  await ensurePeerWorkspaceExcluded(repoRoot);
  const commitDir = resolvePeerCommitDir(repoRoot, bundle.pr.number, bundle.headSha);
  const stageDir = join(commitDir, "02-review");
  await mkdir(stageDir, { recursive: true });

  const walkthroughMd = renderWalkthroughComment(bundle);
  const reportMd = renderCombinedLocalReviewMarkdown(bundle);
  const manifest = buildRunManifest(bundle, {
    ...meta,
    completedStages: ["analyze", "review"],
    latestStage: "review",
  });

  await Promise.all([
    Bun.write(join(stageDir, "report.md"), reportMd),
    Bun.write(join(stageDir, "walkthrough.md"), walkthroughMd),
    Bun.write(join(stageDir, "bundle.json"), JSON.stringify(bundle, null, 2)),
    Bun.write(join(commitDir, "review.md"), reportMd),
    Bun.write(join(commitDir, "run.json"), JSON.stringify(manifest, null, 2)),
  ]);

  return commitDir;
}

export async function writeVerifyStageArtifacts(
  repoRoot: string,
  bundle: ReviewBundle,
  skepticSummary: {
    readonly keptCount: number;
    readonly refutedItems: readonly ConsideredAndRejectedItem[];
  },
  meta: WriteArtifactsMeta = {},
): Promise<string> {
  await ensurePeerWorkspaceExcluded(repoRoot);
  const commitDir = resolvePeerCommitDir(repoRoot, bundle.pr.number, bundle.headSha);
  const stageDir = join(commitDir, "03-verify");
  await mkdir(stageDir, { recursive: true });

  const reportMd = renderCombinedLocalReviewMarkdown(bundle);
  const manifest = buildRunManifest(bundle, {
    ...meta,
    completedStages: ["analyze", "review", "verify"],
    latestStage: "verify",
  });

  await Promise.all([
    Bun.write(join(stageDir, "report.md"), reportMd),
    Bun.write(join(stageDir, "skeptic.json"), JSON.stringify(skepticSummary, null, 2)),
    Bun.write(join(stageDir, "bundle.json"), JSON.stringify(bundle, null, 2)),
    Bun.write(join(commitDir, "review.md"), reportMd),
    Bun.write(join(commitDir, "run.json"), JSON.stringify(manifest, null, 2)),
  ]);

  return commitDir;
}

export async function writePublishStageArtifacts(
  repoRoot: string,
  bundle: ReviewBundle,
  publishInfo: {
    readonly sourceStage: PipelineStage;
    readonly submitted: boolean;
    readonly inlineCommentsCount: number;
  },
  existingStages: readonly PipelineStage[],
  meta: WriteArtifactsMeta = {},
): Promise<string> {
  await ensurePeerWorkspaceExcluded(repoRoot);
  const commitDir = resolvePeerCommitDir(repoRoot, bundle.pr.number, bundle.headSha);
  const stageDir = join(commitDir, "04-publish");
  await mkdir(stageDir, { recursive: true });

  const completedStages = Array.from(new Set<PipelineStage>([...existingStages, "publish"]));
  const publishReport = [
    `# GitHub Publish Receipt — PR #${bundle.pr.number}`,
    "",
    `- **PR URL:** ${bundle.pr.htmlUrl}`,
    `- **Commit:** \`${bundle.headSha.slice(0, 7)}\``,
    `- **Source Stage:** \`${publishInfo.sourceStage}\``,
    `- **Review Mode:** ${publishInfo.submitted ? "Submitted (`COMMENT`)" : "Draft (`PENDING`)"}`,
    `- **Inline Comments Posted:** ${publishInfo.inlineCommentsCount}`,
    `- **Published At:** ${new Date().toISOString()}`,
    "",
  ].join("\n");

  const manifest = buildRunManifest(bundle, {
    ...meta,
    completedStages,
    latestStage: "publish",
  });

  await Promise.all([
    Bun.write(join(stageDir, "report.md"), publishReport),
    Bun.write(join(commitDir, "run.json"), JSON.stringify(manifest, null, 2)),
  ]);

  return commitDir;
}

export async function loadJsonIfExists<T>(
  filePath: string,
  parser: { parse: (val: unknown) => T },
): Promise<T | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return parser.parse(await file.json());
  } catch {
    return null;
  }
}

export async function loadRawJsonIfExists<T>(filePath: string): Promise<T | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }
  try {
    return (await file.json()) as T;
  } catch {
    return null;
  }
}
