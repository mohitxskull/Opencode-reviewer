#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AuditLogger } from "./audit.ts";
import { filterCodeOnlyDiffMap, parseUnifiedDiff } from "./diff.ts";
import {
  CheckpointStore,
  detectRepoOwnerAndName,
  ensureCleanWorkingTree,
  runGitSync,
  tryGitRawSync,
  withInPlaceCheckout,
} from "./git.ts";
import {
  GitHubClient,
  type InlineReviewCommentInput,
  parsePrTarget,
  resolveGitHubToken,
} from "./github.ts";
import { buildRustSymbolGraph } from "./graph.ts";
import { clippyToFindings, partitionAndFilterFindings } from "./judge.ts";
import { LearningStore } from "./learnings.ts";
import {
  type MultiLensRunResult,
  OpenCodeMultiLensOrchestrator,
  parseModelSpec,
  type ReviewContext,
} from "./lenses.ts";
import {
  type DeletionProposedItem,
  ReviewBundleSchema,
  type ReviewProfile,
  ReviewProfileSchema,
} from "./models.ts";
import {
  renderInlineFindingComment,
  renderPrReviewSummaryBody,
  renderWalkthroughComment,
  writeLocalReviewArtifacts,
} from "./render/markdown.ts";
import { formatTerminalReport } from "./render/terminal.ts";
import {
  collectClippyDiagnostics,
  collectCrateGraph,
  collectRustToolchainBaseline,
} from "./rust.ts";
import { SuggestionCompilerVerifier } from "./verifier.ts";

export type LensRunnerFn = (context: ReviewContext) => Promise<MultiLensRunResult>;

export interface CliDependencies {
  readonly githubClient?: GitHubClient;
  readonly lensRunner?: LensRunnerFn;
  readonly promptSelectPr?: (
    prs: ReadonlyArray<{ number: number; title: string }>,
  ) => Promise<number>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const HELP_TEXT = `peer — Local-First Rust PR Reviewer (OpenCode SDK + Octokit)

Usage:
  peer [review] [PR_NUMBER_OR_URL] [options]
  peer learn add "<rule>" [--scope "<glob>"] [--repo <path>]
  peer learn list [--repo <path>]
  peer learn remove <id> [--repo <path>]

Options:
  --repo <path>              Target local Rust git repository (default: cwd)
  --profile <profile>        Review profile: quiet | chill | assertive (default: chill)
  --fresh                    Ignore saved checkpoint and review full PR diff
  --local-only               Save local review artifacts without posting to GitHub
  --post                     Post Walkthrough comment and PENDING draft review to GitHub
  --submit-review            Submit review with event=COMMENT instead of PENDING draft
  --model <provider/model>   OpenCode model spec (default: hy4-flash-free)
  --scope <glob>             Optional path glob for 'peer learn add' (e.g. "src/oms/**")
  -h, --help                 Show this help message
`;

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<number> {
  const writeOut = deps.stdout ?? ((text: string) => console.log(text));
  const writeErr = deps.stderr ?? ((text: string) => console.error(text));

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        profile: { type: "string" },
        fresh: { type: "boolean", default: false },
        "local-only": { type: "boolean", default: false },
        post: { type: "boolean", default: false },
        "submit-review": { type: "boolean", default: false },
        model: { type: "string" },
        scope: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });

    if (parsed.values.help) {
      writeOut(HELP_TEXT);
      return 0;
    }

    const repoRoot = resolve(parsed.values.repo ?? process.cwd());
    const learningStore = new LearningStore(repoRoot);

    if (parsed.positionals[0] === "learn") {
      const action = parsed.positionals[1];
      if (action === "add") {
        const ruleText = parsed.positionals.slice(2).join(" ").trim();
        if (!ruleText) {
          writeErr('Usage: peer learn add "<rule>" [--scope "<glob>"]');
          return 1;
        }
        const entry = await learningStore.add({
          rule: ruleText,
          scope: parsed.values.scope ?? null,
        });
        writeOut(
          `Added learning [${entry.id}]${entry.scope ? ` (scope: ${entry.scope})` : ""}: ${entry.rule}`,
        );
        return 0;
      }
      if (action === "list") {
        const list = await learningStore.list();
        if (list.length === 0) {
          writeOut("No repository learnings recorded yet.");
        } else {
          for (const item of list) {
            writeOut(
              `[${item.id}] ${item.scope ? `(scope: ${item.scope}) ` : "(global) "}${item.rule}`,
            );
          }
        }
        return 0;
      }
      if (action === "remove") {
        const id = parsed.positionals[2]?.trim();
        if (!id) {
          writeErr("Usage: peer learn remove <id>");
          return 1;
        }
        const removed = await learningStore.remove(id);
        if (!removed) {
          writeErr(`Learning ID "${id}" not found.`);
          return 1;
        }
        writeOut(`Removed learning [${id}].`);
        return 0;
      }
      writeErr("Unknown learn subcommand. Expected: peer learn add | list | remove");
      return 1;
    }
    const profile: ReviewProfile = ReviewProfileSchema.parse(parsed.values.profile ?? "assertive");
    const fresh = parsed.values.fresh ?? false;
    const localOnly = parsed.values["local-only"] ?? false;
    const postToGitHub = parsed.values.post ?? false;
    const submitReview = parsed.values["submit-review"] ?? false;

    // Step 1: Enforce clean working tree BEFORE any network or git mutation
    await ensureCleanWorkingTree(repoRoot);

    const positionals = [...parsed.positionals];
    if (positionals[0] === "review") {
      positionals.shift();
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

    const githubClient =
      deps.githubClient ??
      new GitHubClient({
        token: await resolveGitHubToken(),
      });

    let owner = defaultOwner;
    let repo = defaultRepo;
    let prNumber: number;

    if (rawPrTarget) {
      const target = parsePrTarget(rawPrTarget, defaultOwner, defaultRepo);
      owner = target.owner;
      repo = target.repo;
      prNumber = target.prNumber;
    } else {
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

    if (owner === "unknown" || repo === "unknown") {
      writeErr(
        "Unable to determine GitHub repository owner/name from 'origin' remote. Configure a GitHub 'origin' remote or pass a full GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>).",
      );
      return 1;
    }

    const pr = await githubClient.getPullRequest(owner, repo, prNumber);
    const checkpointStore = new CheckpointStore(repoRoot);
    const modelSpec = parseModelSpec(parsed.values.model);

    const auditLogger = new AuditLogger({
      repoRoot,
      prNumber: pr.number,
      onProgress: (line) => writeOut(line),
    });

    await auditLogger.logEvent(
      "run.started",
      `▶ Stage 1/6: Resolved PR #${pr.number} (${owner}/${repo}: "${pr.title}") head=${pr.headSha.slice(0, 7)} base=${pr.baseSha.slice(0, 7)}`,
      {
        owner,
        repo,
        prNumber: pr.number,
        title: pr.title,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        model: `${modelSpec.providerID}/${modelSpec.id}`,
        fresh,
        localOnly,
        postToGitHub,
      },
    );

    let failedCohortsCount = 0;
    const bundle = await withInPlaceCheckout(
      {
        repoRoot,
        targetSha: pr.headSha,
        prNumber: pr.number,
      },
      async () => {
        const { diffBaseSha, isIncremental } = await checkpointStore.resolveDiffBase({
          prNumber: pr.number,
          prBaseSha: pr.baseSha,
          currentHeadSha: pr.headSha,
          fresh,
        });

        let diffText: string;
        const diffRangeSpec = isIncremental
          ? `${diffBaseSha}..${pr.headSha}`
          : `${diffBaseSha}...${pr.headSha}`;
        const localDiffAttempt = tryGitRawSync(repoRoot, [
          "diff",
          "--no-color",
          "--unified=3",
          diffRangeSpec,
        ]);
        if (localDiffAttempt.ok && (isIncremental || localDiffAttempt.stdout.length > 0)) {
          diffText = localDiffAttempt.stdout;
        } else {
          diffText = await githubClient.getPullRequestDiff(owner, repo, pr.number);
        }

        const rawDiffMap = parseUnifiedDiff(diffText);
        const diffMap = filterCodeOnlyDiffMap(rawDiffMap);
        const modifiedFiles = new Set(Object.keys(diffMap));
        const excludedFiles = Object.keys(rawDiffMap).filter((fp) => !modifiedFiles.has(fp));

        await auditLogger.logEvent(
          "stage.checkout_and_diff",
          `▶ Stage 2/6: Checked out ${pr.headSha.slice(0, 7)} (${modifiedFiles.size} Rust code files kept, ${excludedFiles.length} non-code files skipped, profile=${profile})`,
          {
            diffBaseSha,
            headSha: pr.headSha,
            isIncremental,
            profile,
            keptRustFiles: Array.from(modifiedFiles),
            excludedNonCodeFiles: excludedFiles,
          },
        );

        await auditLogger.logEvent(
          "stage.rust_ground_truth.started",
          `▶ Stage 3/6: Collecting local Rust ground truth (cargo metadata + cargo clippy + symbol call-site graph)...`,
        );
        const gtStartMs = Date.now();

        const [crateGraph, clippyDiagnostics, symbolGraph, learnings] = await Promise.all([
          collectCrateGraph(repoRoot),
          collectClippyDiagnostics(repoRoot, modifiedFiles),
          buildRustSymbolGraph(repoRoot, diffMap),
          learningStore.getMatchingLearnings(modifiedFiles),
        ]);

        await auditLogger.logEvent(
          "stage.rust_ground_truth.completed",
          `  ├─ ✓ Rust ground truth ready in ${Date.now() - gtStartMs}ms (${Object.keys(crateGraph.crates).length} crate(s), ${clippyDiagnostics.length} Clippy diagnostic(s), ${symbolGraph.nodes.length} modified symbol(s) graphed, ${learnings.length} repo learning(s))`,
          {
            durationMs: Date.now() - gtStartMs,
            crateCount: Object.keys(crateGraph.crates).length,
            clippyCount: clippyDiagnostics.length,
            clippyDiagnostics,
            symbolGraphNodes: symbolGraph.nodes.map((n) => ({
              name: n.name,
              kind: n.kind,
              filePath: n.filePath,
              line: n.line,
              prodRefs: n.prodReferences.length,
              testRefs: n.testReferences.length,
            })),
            learningsCount: learnings.length,
          },
        );

        const reviewContext: ReviewContext = {
          repoRoot,
          pr,
          diffBaseSha,
          headSha: pr.headSha,
          isIncremental,
          crateGraph,
          diffMap,
          clippyDiagnostics,
          symbolGraph,
          learnings,
          auditLogger,
        };

        await auditLogger.logEvent(
          "stage.lenses.started",
          `▶ Stage 4/6: Running OpenCode review lenses (model: ${modelSpec.providerID}/${modelSpec.id})...`,
          {
            model: `${modelSpec.providerID}/${modelSpec.id}`,
          },
        );

        const lensRunner: LensRunnerFn =
          deps.lensRunner ??
          (async (ctx) => {
            const orchestrator = new OpenCodeMultiLensOrchestrator({
              model: modelSpec,
            });
            return await orchestrator.runAllLenses(ctx);
          });

        const lensResult = await lensRunner(reviewContext);
        failedCohortsCount = lensResult.failedCohorts?.length ?? 0;
        const { walkthrough, findings: rawLensFindings } = lensResult;

        // Post-lens safety check: restore working tree if any external tool touched tracked files
        runGitSync(repoRoot, ["checkout", "--", "."]);

        // Step 3: Judge Pass (merge Clippy + lens findings, partition into inline / outside-diff / nitpicks)
        const clippyFindings = clippyToFindings(clippyDiagnostics, diffMap);
        const partitioned = partitionAndFilterFindings(
          [...clippyFindings, ...rawLensFindings],
          diffMap,
          profile,
        );

        await auditLogger.logEvent(
          "stage.judge.completed",
          `▶ Stage 5/6: Judge partitioned ${rawLensFindings.length + clippyFindings.length} raw findings -> ${partitioned.inlineFindings.length} inline, ${partitioned.outsideDiffFindings.length} outside-diff, ${partitioned.nitpickFindings.length} nitpicks (${lensResult.consideredAndRejected?.length ?? 0} hypotheses considered & rejected). Running cargo check on suggestions...`,
          {
            rawLensFindingsCount: rawLensFindings.length,
            clippyFindingsCount: clippyFindings.length,
            inlineCount: partitioned.inlineFindings.length,
            outsideDiffCount: partitioned.outsideDiffFindings.length,
            nitpickCount: partitioned.nitpickFindings.length,
            consideredAndRejectedCount: lensResult.consideredAndRejected?.length ?? 0,
            deletionsProposedCount: lensResult.deletionsProposed?.length ?? 0,
            openQuestionsCount: lensResult.openQuestions?.length ?? 0,
          },
        );

        // Step 4: Transactional cargo check verification of single-hunk inline diff suggestions
        const verifier = new SuggestionCompilerVerifier();
        const verifiedInline = await verifier.verifySuggestions(
          repoRoot,
          partitioned.inlineFindings,
          auditLogger,
        );
        const verifiedOutside = partitioned.outsideDiffFindings;

        const baseline = collectRustToolchainBaseline(repoRoot);
        const graphDeletions: DeletionProposedItem[] = symbolGraph.nodes
          .filter(
            (n) =>
              n.prodReferences.length === 0 &&
              n.testReferences.length === 0 &&
              !n.name.startsWith("test_") &&
              !n.filePath.includes("tests"),
          )
          .map((n) => ({
            pathOrSymbol: `${n.kind} ${n.name} (${n.filePath}:${n.line})`,
            reachabilityEvidence:
              "git grep -n -w across *.rs -> 0 production callers and 0 test references outside definition",
            replacement:
              "Verify whether newly added public API or dead symbol eligible for deletion",
          }));

        const mergedDeletions = [...(lensResult.deletionsProposed ?? []), ...graphDeletions];

        return ReviewBundleSchema.parse({
          pr,
          diffBaseSha,
          headSha: pr.headSha,
          isIncremental,
          profile,
          baseline,
          walkthrough,
          findings: verifiedInline,
          outsideDiffFindings: verifiedOutside,
          nitpickFindings: partitioned.nitpickFindings,
          consideredAndRejected: lensResult.consideredAndRejected ?? [],
          deletionsProposed: mergedDeletions,
          openQuestions: lensResult.openQuestions ?? [],
          notReviewed: excludedFiles.map((f) => `${f} (non-Rust or documentation file skipped)`),
          clippyDiagnostics: [...clippyDiagnostics],
          generatedAt: new Date().toISOString(),
        });
      },
    );

    // Step 5: Persist local artifacts & checkpoint inside .git/peer/reviews/pr-<num>/
    // Do not advance incremental checkpoint if any cohort failed (F-07)
    const artifactDir = await writeLocalReviewArtifacts(repoRoot, bundle);
    if (failedCohortsCount === 0) {
      await checkpointStore.save({
        prNumber: pr.number,
        baseSha: pr.baseSha,
        lastReviewedHeadSha: pr.headSha,
        reviewedAt: bundle.generatedAt,
        profile: bundle.profile,
      });
    }

    await auditLogger.logEvent(
      "run.completed",
      `▶ Stage 6/6: Review complete! Artifacts & audit log written to ${artifactDir}`,
      {
        artifactDir,
        auditJsonlPath: auditLogger.getLatestAuditJsonlPath(),
        runAuditJsonlPath: auditLogger.getRunAuditJsonlPath(),
        inlineFindingsCount: bundle.findings.length,
        outsideDiffFindingsCount: bundle.outsideDiffFindings?.length ?? 0,
        nitpickFindingsCount: bundle.nitpickFindings?.length ?? 0,
      },
    );

    writeOut(formatTerminalReport(bundle, repoRoot, artifactDir));

    // Step 6: Post to GitHub if --post was specified and --local-only was not
    if (postToGitHub && !localOnly) {
      const walkthroughCommentBody = renderWalkthroughComment(bundle);
      await githubClient.upsertWalkthroughComment(owner, repo, pr.number, walkthroughCommentBody);

      const inlineComments: InlineReviewCommentInput[] = bundle.findings.map((finding) => ({
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
        submit: submitReview,
        summaryBody: renderPrReviewSummaryBody(bundle),
      });
    }

    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`Error: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
