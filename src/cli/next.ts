import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type RunManifest, RunManifestSchema } from "../domain/models.ts";
import { loadJsonIfExists } from "../workspace/artifacts.ts";
import { tryGitSync } from "../workspace/git.ts";

async function findLatestRunManifest(
  repoRoot: string,
  prFilter?: number,
): Promise<{ manifest: RunManifest; commitDir: string } | null> {
  const peerDir = join(repoRoot, ".peer");
  let prDirs: string[];
  try {
    prDirs = await readdir(peerDir);
  } catch {
    return null;
  }

  let best: { manifest: RunManifest; commitDir: string; mtime: number } | null = null;

  for (const prEntry of prDirs) {
    if (prEntry === "local" || !/^\d+$/.test(prEntry)) {
      continue;
    }
    const prNum = Number.parseInt(prEntry, 10);
    if (prFilter !== undefined && prNum !== prFilter) {
      continue;
    }
    const prPath = join(peerDir, prEntry);
    let shaDirs: string[];
    try {
      shaDirs = await readdir(prPath);
    } catch {
      continue;
    }
    for (const shaEntry of shaDirs) {
      const commitDir = join(prPath, shaEntry);
      const manifest = await loadJsonIfExists(join(commitDir, "run.json"), RunManifestSchema);
      if (!manifest) {
        continue;
      }
      const mtime = Date.parse(manifest.generatedAt) || 0;
      if (!best || mtime >= best.mtime) {
        best = { manifest, commitDir, mtime };
      }
    }
  }

  return best ? { manifest: best.manifest, commitDir: best.commitDir } : null;
}

export async function runNextCommand(
  repoRoot: string,
  prArg: string | undefined,
  writeOut: (text: string) => void,
  options: { readonly json?: boolean; readonly quiet?: boolean } = {},
): Promise<number> {
  const prFilter =
    prArg && /^\d+$/.test(prArg.trim()) ? Number.parseInt(prArg.trim(), 10) : undefined;
  const latest = await findLatestRunManifest(repoRoot, prFilter);

  if (!latest) {
    if (options.json || options.quiet) {
      writeOut(
        JSON.stringify(
          {
            status: "uninitialized",
            prNumber: prFilter ?? null,
            nextAction: {
              stage: "analyze",
              command: prFilter ? `peer analyze ${prFilter}` : "peer analyze <PR_NUMBER>",
              fallbackLocalGate: "peer check --base main",
            },
          },
          null,
          options.quiet ? undefined : 2,
        ),
      );
      return 0;
    }
    writeOut(
      [
        "peer next — No saved PR review run found in .peer/",
        "",
        "Recommended next step:",
        "  1. Fast local branch check (no GitHub token):  peer check --base main",
        "  2. Start a full PR review (Stage 1 analyze):   peer analyze <PR_NUMBER>",
      ].join("\n"),
    );
    return 0;
  }

  const { manifest, commitDir } = latest;
  const relDir = `.peer/${manifest.prNumber}/${manifest.headSha.slice(0, 7)}`;
  const headRes = tryGitSync(repoRoot, ["rev-parse", "HEAD"]);
  const currentHead = headRes.ok ? headRes.stdout.trim() : "";
  const headDrifted =
    currentHead.length >= 7 &&
    !manifest.headSha.startsWith(currentHead.slice(0, 7)) &&
    !currentHead.startsWith(manifest.headSha.slice(0, 7));

  if (options.json || options.quiet) {
    const nextAction =
      manifest.latestStage === "analyze"
        ? {
            stage: "review",
            command: `peer finalize ${manifest.prNumber} --from ${relDir}/reviews --strict`,
            cohortsIndex: resolve(commitDir, "01-analyze", "cohorts", "index.json"),
          }
        : manifest.latestStage === "review"
          ? {
              stage: "verify",
              command: `peer finalize ${manifest.prNumber} --verdicts ${relDir}/verdicts.md --strict`,
              skepticIndex: resolve(commitDir, "02-review", "skeptic", "index.json"),
            }
          : {
              stage: "publish",
              command: `peer publish ${manifest.prNumber}`,
              todoJson: resolve(commitDir, "todo.json"),
            };

    writeOut(
      JSON.stringify(
        {
          status: manifest.status,
          prNumber: manifest.prNumber,
          headSha: manifest.headSha,
          localHeadSha: currentHead || null,
          headDrifted,
          latestStage: manifest.latestStage,
          completedStages: manifest.completedStages,
          enabledTools: manifest.enabledTools,
          skippedTools: manifest.skippedTools,
          toolOutcomes: manifest.toolOutcomes,
          failedCohorts: manifest.failedCohorts,
          counts: {
            inline: manifest.inlineFindingsCount,
            outsideDiff: manifest.outsideDiffFindingsCount,
            nitpicks: manifest.nitpickFindingsCount,
            clippy: manifest.clippyCount,
            securityAdvisories: manifest.securityAdvisoriesCount,
          },
          artifacts: {
            commitDir: resolve(commitDir),
            reviewMd: resolve(commitDir, "review.md"),
            todoMd: resolve(commitDir, "todo.md"),
            todoJson: resolve(commitDir, "todo.json"),
            cohortsIndexJson: resolve(commitDir, "01-analyze", "cohorts", "index.json"),
            skepticIndexJson: resolve(commitDir, "02-review", "skeptic", "index.json"),
          },
          nextAction,
        },
        null,
        options.quiet ? undefined : 2,
      ),
    );
    return 0;
  }

  const lines: string[] = [
    `peer next — PR #${manifest.prNumber} @ ${manifest.headSha.slice(0, 7)} (latestStage=${manifest.latestStage}, completed=[${manifest.completedStages.join(", ")}])`,
    `Artifacts: file://${resolve(commitDir)}`,
  ];

  if (headDrifted) {
    lines.push(
      `WARNING: Local HEAD (${currentHead.slice(0, 7)}) differs from analyzed PR commit (${manifest.headSha.slice(0, 7)}).`,
      `         If you pushed new commits to the PR, re-run: peer analyze ${manifest.prNumber} --fresh`,
    );
  }

  lines.push("");

  if (manifest.latestStage === "analyze") {
    lines.push(
      "Current Stage: 01-analyze (deterministic ground truth & cohort packets ready)",
      "Next Step (Stage 2 — Multi-Lens Review):",
      `  1. Read ${relDir}/01-analyze/prompt-context.md and ${relDir}/01-analyze/cohorts/index.json`,
      "  2. Load lens prompts: peer prompt walkthrough && peer prompt soundness && peer prompt idioms",
      `  3. Write cohort reviews to ${relDir}/reviews/<cohort-id>.md (+ walkthrough.md)`,
      `  4. Finalize & compile-check suggestions: peer finalize ${manifest.prNumber} --from ${relDir}/reviews --strict`,
    );
  } else if (manifest.latestStage === "review") {
    lines.push(
      `Current Stage: 02-review (${manifest.inlineFindingsCount + manifest.outsideDiffFindingsCount} actionable finding(s), suggestions verified with cargo check)`,
      "Next Step (choose one):",
      `  Option A — Adversarial Skeptic Pass (recommended for large/high-risk PRs):`,
      `    1. Load skeptic prompt: peer prompt skeptic`,
      `    2. Audit per-subsystem skeptic packets in ${relDir}/02-review/skeptic/index.json`,
      `    3. Write KEEP/DROP verdicts to ${relDir}/verdicts.md`,
      `    4. Apply verdicts: peer finalize ${manifest.prNumber} --verdicts ${relDir}/verdicts.md --strict`,
      `  Option B — Drain the Fix Queue or Publish:`,
      `    - Work fixes locally from: file://${resolve(commitDir, "todo.md")}`,
      `    - Or publish PENDING draft review to GitHub: peer publish ${manifest.prNumber}`,
    );
  } else if (manifest.latestStage === "verify") {
    lines.push(
      `Current Stage: 03-verify (${manifest.inlineFindingsCount + manifest.outsideDiffFindingsCount} skeptic-verified finding(s))`,
      "Next Step:",
      `  - Work fixes from the dependency-ordered queue: file://${resolve(commitDir, "todo.md")}`,
      `  - Or publish PENDING draft review to GitHub:    peer publish ${manifest.prNumber}`,
      `  - Or submit immediately as public COMMENT:      peer publish ${manifest.prNumber} --submit`,
    );
  } else {
    lines.push(
      "Current Stage: 04-publish (review published to GitHub)",
      `  - View local fix queue: file://${resolve(commitDir, "todo.md")}`,
      `  - Re-analyze after new commits: peer analyze ${manifest.prNumber} --fresh`,
    );
  }

  writeOut(lines.join("\n"));
  return 0;
}
