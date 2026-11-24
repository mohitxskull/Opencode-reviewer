import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RustSymbolGraph } from "../analyzers/symbol-graph.ts";
import {
  type AnalyzeStageContext,
  type ConsideredAndRejectedItem,
  PEER_VERSION,
  type PipelineStage,
  type ReviewBundle,
  ReviewBundleSchema,
  type RunManifest,
  RunManifestSchema,
  type ToolOutcomeDetail,
} from "../domain/models.ts";
import { renderCombinedLocalReviewMarkdown, renderWalkthroughComment } from "../render/markdown.ts";
import { buildReviewTodoQueue, renderReviewTodoMarkdown } from "../render/todo.ts";
import {
  ensurePeerWorkspaceExcluded,
  resolvePeerCommitDir,
  resolvePeerWorkspaceDir,
} from "./git.ts";

export interface WriteArtifactsMeta {
  readonly model?: string;
  readonly durationMs?: number;
  readonly completedStages?: readonly PipelineStage[];
  readonly latestStage?: PipelineStage;
  readonly enabledTools?: readonly string[];
  readonly toolOutcomes?: Readonly<Record<string, ToolOutcomeDetail>>;
  readonly configHash?: string;
  readonly symbolGraph?: RustSymbolGraph;
  readonly promptContextMd?: string;
  readonly cohortPrompts?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly filePaths: readonly string[];
    readonly markdown: string;
  }>;
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
    peerVersion: PEER_VERSION,
    configHash: meta.configHash ?? "default",
    status: failedCohorts.length > 0 ? "partial" : "completed",
    completedStages: meta.completedStages ?? ["analyze", "review"],
    latestStage: meta.latestStage ?? "review",
    enabledTools: meta.enabledTools ?? [],
    toolOutcomes: meta.toolOutcomes ?? {},
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
  if (meta.cohortPrompts && meta.cohortPrompts.length > 0) {
    const cohortsDir = join(stageDir, "cohorts");
    const reviewsDir = join(commitDir, "reviews");
    await mkdir(cohortsDir, { recursive: true });
    await mkdir(reviewsDir, { recursive: true });
    const indexPayload = meta.cohortPrompts.map((c) => {
      const packetPath = resolve(cohortsDir, `${c.id}.md`);
      const outputPath = resolve(reviewsDir, `${c.id}.md`);
      return {
        id: c.id,
        label: c.label,
        file: `${c.id}.md`,
        packetPath,
        outputPath,
        fileCount: c.filePaths.length,
        filePaths: c.filePaths,
        subagentBrief: `Read ${packetPath}, audit every diff hunk for Rust soundness/concurrency/idiom defects (strictly read-only: use file read/search tools only; do NOT run cargo test, cargo check, or cargo clippy in the shell), write Structured Markdown findings to ${outputPath}, and return ONLY the output file path + finding count.`,
      };
    });
    writes.push(Bun.write(join(cohortsDir, "index.json"), JSON.stringify(indexPayload, null, 2)));
    for (const cohort of meta.cohortPrompts) {
      writes.push(Bun.write(join(cohortsDir, `${cohort.id}.md`), cohort.markdown));
    }
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
  const skepticDir = join(stageDir, "skeptic");
  await mkdir(skepticDir, { recursive: true });

  const walkthroughMd = renderWalkthroughComment(bundle);
  const reportMd = renderCombinedLocalReviewMarkdown(bundle);
  const todoMd = renderReviewTodoMarkdown(bundle);
  const todoJson = buildReviewTodoQueue(bundle);
  const manifest = buildRunManifest(bundle, {
    ...meta,
    completedStages: ["analyze", "review"],
    latestStage: "review",
  });

  // Slice Stage 2 candidate findings into per-subsystem skeptic packets so agents can fan out
  // parallel skeptic subagents without writing custom JSON-slicing scripts.
  const allCandidates = [...bundle.findings, ...(bundle.outsideDiffFindings ?? [])].filter(
    (f) => f.source !== "clippy" && (f.source !== "audit" || f.id.startsWith("audit-ast-")),
  );
  const bySubsystem = new Map<string, typeof allCandidates>();
  for (const f of allCandidates) {
    const parts = f.filePath.split("/").filter(Boolean);
    const key =
      parts.length >= 3
        ? parts.slice(0, 3).join("/")
        : parts.slice(0, Math.max(1, parts.length - 1)).join("/") || "root";
    const list = bySubsystem.get(key) ?? [];
    list.push(f);
    bySubsystem.set(key, list);
  }

  const sortedSubsystems = Array.from(bySubsystem.entries()).sort(([a], [b]) => a.localeCompare(b));
  const verdictsDir = join(commitDir, "verdicts");
  await mkdir(verdictsDir, { recursive: true });
  const skepticIndex: Array<{
    id: string;
    subsystem: string;
    file: string;
    packetPath: string;
    outputPath: string;
    findingCount: number;
    findingIds: string[];
    subagentBrief: string;
  }> = [];
  const skepticWrites: Promise<unknown>[] = [];

  for (let i = 0; i < sortedSubsystems.length; i++) {
    const entry = sortedSubsystems[i];
    if (!entry) continue;
    const [subsystem, groupFindings] = entry;
    const slug =
      subsystem
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "root";
    const packetId = `skeptic-${String(i + 1).padStart(2, "0")}-${slug}`;
    const packetFile = `${packetId}.md`;
    const packetPath = resolve(skepticDir, packetFile);
    const outputPath = resolve(verdictsDir, packetFile);
    skepticIndex.push({
      id: packetId,
      subsystem,
      file: packetFile,
      packetPath,
      outputPath,
      findingCount: groupFindings.length,
      findingIds: groupFindings.map((f) => f.id),
      subagentBrief: `Read ${packetPath}, independently verify or refute each finding against the repository source code (strictly read-only: use file read/search tools only; do NOT run cargo test or cargo check in the shell), write KEEP/DROP verdict lines to ${outputPath}, and return ONLY the output file path + KEEP/DROP counts.`,
    });

    const packetLines = [
      `# Skeptic Verification Packet: \`${packetId}\` (${subsystem})`,
      "",
      `- **PR:** #${bundle.pr.number} (\`${bundle.headSha.slice(0, 7)}\`)`,
      `- **Candidate Findings:** ${groupFindings.length}`,
      `- **Target Output File:** \`${outputPath}\``,
      "",
      "For each finding below, independently verify the claim against the repository source code and write one verdict line per finding to the Target Output File above:",
      "`- <finding-id> | KEEP|DROP | <concise technical proof>`",
      "Return **ONLY** the Target Output File path + KEEP/DROP counts.",
      "",
    ];
    for (const f of groupFindings) {
      const range = f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}-L${f.endLine}`;
      packetLines.push(`## \`${f.id}\` — [${f.severity}] (${f.type}) ${f.title}`);
      packetLines.push(`- **File:** \`${f.filePath}:${range}\``);
      packetLines.push(`- **Root Cause:** ${f.rootCause}`);
      packetLines.push(
        `- **Patch Verification:** ${f.suggestion ? (f.suggestionVerified ? "cargo check OK" : "unverified") : "none"}`,
      );
      packetLines.push("");
      packetLines.push(f.body);
      if (f.suggestion) {
        packetLines.push("");
        packetLines.push("```rust");
        packetLines.push(f.suggestion);
        packetLines.push("```");
      }
      packetLines.push("");
    }
    skepticWrites.push(Bun.write(join(skepticDir, packetFile), packetLines.join("\n")));
  }
  skepticWrites.push(
    Bun.write(join(skepticDir, "index.json"), JSON.stringify(skepticIndex, null, 2)),
  );

  await Promise.all([
    Bun.write(join(stageDir, "report.md"), reportMd),
    Bun.write(join(stageDir, "walkthrough.md"), walkthroughMd),
    Bun.write(join(stageDir, "bundle.json"), JSON.stringify(bundle, null, 2)),
    Bun.write(join(commitDir, "review.md"), reportMd),
    Bun.write(join(commitDir, "todo.md"), todoMd),
    Bun.write(join(commitDir, "todo.json"), JSON.stringify(todoJson, null, 2)),
    Bun.write(join(commitDir, "run.json"), JSON.stringify(manifest, null, 2)),
    ...skepticWrites,
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
  const todoMd = renderReviewTodoMarkdown(bundle);
  const todoJson = buildReviewTodoQueue(bundle);
  const manifest = buildRunManifest(bundle, {
    ...meta,
    completedStages: ["analyze", "review", "verify"],
    latestStage: "verify",
  });

  await Promise.all([
    Bun.write(join(stageDir, "report.md"), reportMd),
    Bun.write(join(commitDir, "todo.md"), todoMd),
    Bun.write(join(commitDir, "todo.json"), JSON.stringify(todoJson, null, 2)),
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

/**
 * Finds the most recently generated Stage 3 (`03-verify/bundle.json`) or Stage 2 (`02-review/bundle.json`)
 * review bundle from an earlier commit under `.peer/<prNumber>/` so follow-up runs on the same PR
 * can automatically inject a Prior PR Review Findings ledger into `prompt-context.md` and cohort packets.
 */
export async function loadPriorPrReviewBundle(
  repoRoot: string,
  prNumber: number,
  currentHeadSha: string,
): Promise<ReviewBundle | null> {
  const prDir = join(resolvePeerWorkspaceDir(repoRoot), String(prNumber));
  const currentShort = currentHeadSha.slice(0, 7).toLowerCase();
  let entries: string[];
  try {
    entries = await readdir(prDir);
  } catch {
    return null;
  }

  let latestBundle: ReviewBundle | null = null;
  let latestTimestamp = -1;

  for (const entry of entries) {
    if (entry.toLowerCase() === currentShort || !/^[0-9a-f]{7,40}$/i.test(entry)) {
      continue;
    }
    const candidateDir = join(prDir, entry);
    const bundle =
      (await loadJsonIfExists(
        join(candidateDir, "03-verify", "bundle.json"),
        ReviewBundleSchema,
      )) ??
      (await loadJsonIfExists(join(candidateDir, "02-review", "bundle.json"), ReviewBundleSchema));
    if (!bundle || bundle.headSha.toLowerCase() === currentHeadSha.toLowerCase()) {
      continue;
    }
    const ts = Date.parse(bundle.generatedAt);
    const score = Number.isFinite(ts) ? ts : 0;
    if (score >= latestTimestamp) {
      latestTimestamp = score;
      latestBundle = bundle;
    }
  }

  return latestBundle;
}
