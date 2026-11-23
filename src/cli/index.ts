#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type PipelineStage,
  type ReviewProfile,
  ReviewProfileSchema,
  type RunManifest,
  RunManifestSchema,
} from "../domain/models.ts";
import { GitHubClient, parsePrTarget, resolveGitHubToken } from "../github/client.ts";
import { parseModelSpec } from "../llm/client.ts";
import { type OptionalTool, runAnalyzeStage } from "../pipeline/analyze.ts";
import { runPublishStage } from "../pipeline/publish.ts";
import { type LensRunnerFn, runReviewStage } from "../pipeline/review.ts";
import { runVerifyStage, type SkepticRunnerFn } from "../pipeline/verify.ts";
import { formatTerminalReport } from "../render/terminal.ts";
import { loadJsonIfExists } from "../workspace/artifacts.ts";
import { AuditLogger } from "../workspace/audit-log.ts";
import {
  CheckpointStore,
  detectRepoOwnerAndName,
  ensureCleanWorkingTree,
  resolveGitTopLevel,
  resolvePeerCommitDir,
} from "../workspace/git.ts";
import { LearningStore } from "../workspace/learnings.ts";
import { runLearnCommand } from "./learn.ts";

export type { LensRunnerFn, SkepticRunnerFn };

export interface CliDependencies {
  readonly githubClient?: GitHubClient;
  readonly lensRunner?: LensRunnerFn;
  readonly skepticRunner?: SkepticRunnerFn;
  readonly promptSelectPr?: (
    prs: ReadonlyArray<{ number: number; title: string }>,
  ) => Promise<number>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const OPTIONAL_TOOLS: readonly OptionalTool[] = ["deny", "geiger", "semver", "coverage", "miri"];
const OPTIONAL_TOOL_SET = new Set<string>(OPTIONAL_TOOLS);
const STAGE_COMMANDS = new Set<PipelineStage>(["analyze", "review", "verify", "publish"]);

const HELP_TEXT = `peer — Local-First Rust PR Reviewer (4-Stage Composable Pipeline)

Commands:
  peer analyze [PR]        Stage 1: Deterministic Rust ground truth only (0 LLM calls)
  peer review  [PR]        Stage 1 -> 2: Reuses analyze, runs LLM lenses + cargo check verifier (default)
  peer verify  [PR]        Stage 1 -> 3: Reuses review, runs adversarial skeptic pass
  peer publish [PR]        Stage 4: Uploads latest saved stage (01, 02, or 03) to GitHub PR
  peer learn add "<rule>" [--scope "<glob>"] [--repo <path>]
  peer learn list [--repo <path>]
  peer learn remove <id> [--repo <path>]

Options:
  --repo <path>              Target local Rust git repository (default: cwd)
  --model <provider/model>   OpenCode model spec (default: hy4-flash-free)
  --profile <profile>        Strictness profile: quiet | chill | assertive (default: assertive)
  --tools <list|all>         Optional Cargo analyzers: deny,geiger,semver,coverage,miri or all
  --concurrency <n>          Max parallel LLM sessions (1-16, default: 4)
  --fresh                    Ignore saved stage artifacts & checkpoint; re-run from scratch
  --submit                   For 'publish': submit as COMMENT instead of PENDING draft
  --allow-partial            Exit 0 and allow publishing even if a lens cohort fails
  --scope <glob>             Optional path glob for 'peer learn add' (e.g. "src/oms/**")
  -h, --help                 Show this help message
`;

export function parseToolsOption(raw?: string): Set<OptionalTool> {
  const selected = new Set<OptionalTool>();
  if (!raw || raw.trim().length === 0) {
    return selected;
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  for (const part of parts) {
    if (part === "all") {
      for (const t of OPTIONAL_TOOLS) {
        selected.add(t);
      }
      continue;
    }
    if (!OPTIONAL_TOOL_SET.has(part)) {
      throw new Error(
        `Unknown tool "${part}" in --tools. Valid values: ${OPTIONAL_TOOLS.join(", ")}, all`,
      );
    }
    selected.add(part as OptionalTool);
  }
  return selected;
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((text: string) => console.log(text));
  const writeErr = deps.stderr ?? ((text: string) => console.error(text));

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        model: { type: "string" },
        profile: { type: "string" },
        tools: { type: "string" },
        concurrency: { type: "string" },
        fresh: { type: "boolean", default: false },
        submit: { type: "boolean", default: false },
        "allow-partial": { type: "boolean", default: false },
        scope: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });

    if (parsed.values.help) {
      writeOut(HELP_TEXT);
      return 0;
    }

    const repoRoot = resolveGitTopLevel(resolve(parsed.values.repo ?? process.cwd()));
    const learningStore = new LearningStore(repoRoot);

    if (parsed.positionals[0] === "learn") {
      return await runLearnCommand(
        parsed.positionals.slice(1),
        parsed.values.scope,
        learningStore,
        writeOut,
        writeErr,
      );
    }

    const positionals = [...parsed.positionals];
    let targetStage: PipelineStage = "review";
    if (positionals[0] && STAGE_COMMANDS.has(positionals[0] as PipelineStage)) {
      targetStage = positionals.shift() as PipelineStage;
    }

    const profile: ReviewProfile = ReviewProfileSchema.parse(parsed.values.profile ?? "assertive");
    const fresh = parsed.values.fresh ?? false;
    const submitReview = parsed.values.submit ?? false;
    const allowPartial = parsed.values["allow-partial"] ?? false;
    const enabledTools = parseToolsOption(parsed.values.tools);
    const enabledToolsList = Array.from(enabledTools).sort();

    if (submitReview && targetStage !== "publish") {
      writeErr("Error: --submit is only valid with `peer publish`.");
      return 1;
    }

    let concurrencyLimit = 4;
    if (parsed.values.concurrency !== undefined) {
      const parsedConcurrency = Number.parseInt(parsed.values.concurrency, 10);
      if (
        !/^\d+$/.test(parsed.values.concurrency.trim()) ||
        parsedConcurrency < 1 ||
        parsedConcurrency > 16
      ) {
        writeErr("Error: --concurrency must be an integer between 1 and 16.");
        return 1;
      }
      concurrencyLimit = parsedConcurrency;
    }

    if (targetStage !== "publish") {
      await ensureCleanWorkingTree(repoRoot);
    }

    const rawPrTarget = positionals[0];
    let defaultOwner = "unknown";
    let defaultRepo = "unknown";
    try {
      const detected = detectRepoOwnerAndName(repoRoot);
      defaultOwner = detected.owner;
      defaultRepo = detected.repo;
    } catch {
      // Allow explicit full PR URL to supply owner/repo if origin remote isn't configured
    }

    let owner = defaultOwner;
    let repo = defaultRepo;
    let prNumber = 0;

    if (rawPrTarget) {
      const target = parsePrTarget(rawPrTarget, defaultOwner, defaultRepo);
      owner = target.owner;
      repo = target.repo;
      prNumber = target.prNumber;
    }

    if (owner === "unknown" || repo === "unknown") {
      writeErr(
        "Unable to determine GitHub repository owner/name from 'origin' remote. Configure a GitHub 'origin' remote or pass a full GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>).",
      );
      return 1;
    }

    const githubClient =
      deps.githubClient ?? new GitHubClient({ token: await resolveGitHubToken() });

    if (!rawPrTarget) {
      const openPrs = await githubClient.listOpenPrs(owner, repo);
      if (openPrs.length === 0) {
        writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
        return 1;
      }
      if (deps.promptSelectPr) {
        prNumber = await deps.promptSelectPr(openPrs);
      } else {
        const firstPr = openPrs[0];
        if (!firstPr) {
          writeErr(`No open Pull Requests found for ${owner}/${repo}.`);
          return 1;
        }
        prNumber = firstPr.number;
      }
    }

    const pr = await githubClient.getPullRequest(owner, repo, prNumber);
    const checkpointStore = new CheckpointStore(repoRoot);
    const modelSpec = parseModelSpec(parsed.values.model);
    const modelLabel = `${modelSpec.providerID}/${modelSpec.id}`;
    const runStartMs = Date.now();
    const commitDir = resolvePeerCommitDir(repoRoot, pr.number, pr.headSha);
    const existingManifest = !fresh
      ? await loadJsonIfExists<RunManifest>(join(commitDir, "run.json"), RunManifestSchema)
      : null;

    if (targetStage === "publish") {
      return await runPublishStage({
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
      });
    }

    if (
      !fresh &&
      existingManifest &&
      existingManifest.status === "completed" &&
      existingManifest.headSha === pr.headSha &&
      existingManifest.profile === profile &&
      existingManifest.completedStages.includes(targetStage)
    ) {
      const stageFolder =
        targetStage === "analyze"
          ? "01-analyze"
          : targetStage === "review"
            ? "02-review"
            : "03-verify";
      writeOut(
        `Already completed stage \`${targetStage}\` for PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (profile=${profile}, ${existingManifest.inlineFindingsCount} inline / ${existingManifest.outsideDiffFindingsCount} outside-diff findings).\nReport: file://${resolve(commitDir, stageFolder, "report.md")}\nPass --fresh to force a re-run.`,
      );
      return 0;
    }

    const auditLogger = new AuditLogger({
      repoRoot,
      prNumber: pr.number,
      headSha: pr.headSha,
      onProgress: (line) => writeOut(line),
    });

    await auditLogger.logEvent(
      "run.started",
      `▶ Resolved PR #${pr.number} (${owner}/${repo}: "${pr.title}") head=${pr.headSha.slice(0, 7)} base=${pr.baseSha.slice(0, 7)} target=${targetStage}`,
      {
        owner,
        repo,
        prNumber: pr.number,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        targetStage,
        model: modelLabel,
        enabledTools: enabledToolsList,
        fresh,
      },
    );

    const analyzeOut = await runAnalyzeStage({
      repoRoot,
      commitDir,
      owner,
      repo,
      pr,
      profile,
      fresh,
      enabledTools,
      enabledToolsList,
      runStartMs,
      githubClient,
      checkpointStore,
      auditLogger,
    });

    if (targetStage === "analyze") {
      writeOut(
        formatTerminalReport(analyzeOut.analyzeBundle, repoRoot, join(commitDir, "01-analyze")),
      );
      return 0;
    }

    const reviewBundle = await runReviewStage({
      repoRoot,
      commitDir,
      profile,
      fresh,
      modelSpec,
      modelLabel,
      concurrencyLimit,
      enabledToolsList,
      runStartMs,
      existingManifest,
      analyzeOut,
      learningStore,
      auditLogger,
      customLensRunner: deps.lensRunner,
    });

    const failedCohortsCount = reviewBundle.failedCohorts?.length ?? 0;
    if (targetStage === "review") {
      writeOut(formatTerminalReport(reviewBundle, repoRoot, join(commitDir, "02-review")));
      if (failedCohortsCount > 0 && !allowPartial) {
        writeErr(
          `Error: ${failedCohortsCount} review cohort(s) failed (${(reviewBundle.failedCohorts ?? []).join(", ")}). Pass --allow-partial to override.`,
        );
        return 2;
      }
      return 0;
    }

    const verifyBundle = await runVerifyStage({
      repoRoot,
      reviewBundle,
      modelSpec,
      modelLabel,
      concurrencyLimit,
      enabledToolsList,
      runStartMs,
      auditLogger,
      customSkepticRunner: deps.skepticRunner,
    });

    writeOut(formatTerminalReport(verifyBundle, repoRoot, join(commitDir, "03-verify")));
    if (failedCohortsCount > 0 && !allowPartial) {
      writeErr(
        `Error: ${failedCohortsCount} review cohort(s) failed (${(verifyBundle.failedCohorts ?? []).join(", ")}). Pass --allow-partial to override.`,
      );
      return 2;
    }
    return 0;
  } catch (err) {
    writeErr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
