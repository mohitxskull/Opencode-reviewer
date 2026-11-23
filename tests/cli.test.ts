import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToolsOption, runCli } from "../src/cli.ts";
import { GitHubClient } from "../src/github.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res.stdout.toString().trim();
}

async function createTempRustGitRepo(): Promise<{
  repoDir: string;
  baseSha: string;
  prHeadSha: string;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "peer-cli-e2e-"));
  tempDirs.push(repoDir);

  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["config", "user.name", "Test Developer"]);
  runGit(repoDir, ["config", "user.email", "dev@example.com"]);
  runGit(repoDir, ["remote", "add", "origin", "https://github.com/tikv/sample-rust.git"]);

  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, ".gitignore"), "/target\n");
  await writeFile(
    join(repoDir, "Cargo.toml"),
    `[package]\nname = "sample_rust"\nversion = "0.1.0"\nedition = "2021"\n`,
  );
  await writeFile(
    join(repoDir, "src", "lib.rs"),
    `pub fn calculate(x: i32) -> i32 {\n    x + 1\n}\n`,
  );

  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "initial base commit"]);
  const baseSha = runGit(repoDir, ["rev-parse", "HEAD"]);

  // Create a PR commit on a branch
  runGit(repoDir, ["checkout", "-b", "pr-42"]);
  await writeFile(
    join(repoDir, "src", "lib.rs"),
    [
      "pub fn calculate(x: i32) -> i32 {",
      "    let doubled = x * 2;",
      "    let incremented = doubled + 1;",
      "    incremented * 3",
      "}",
      "",
    ].join("\n"),
  );
  runGit(repoDir, ["add", "src/lib.rs"]);
  runGit(repoDir, ["commit", "-m", "feat: double before add"]);
  const prHeadSha = runGit(repoDir, ["rev-parse", "HEAD"]);

  // Return to main branch before running peer
  runGit(repoDir, ["checkout", "main"]);

  return { repoDir, baseSha, prHeadSha };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("End-to-end 4-stage composable peer CLI pipeline", () => {
  test("analyze -> review -> verify -> publish reuses prior stages, verifies suggestions, runs skeptic, and publishes PENDING review", async () => {
    const { repoDir, baseSha, prHeadSha } = await createTempRustGitRepo();

    const postedReviews: Array<Record<string, unknown>> = [];
    const postedComments: Array<Record<string, unknown>> = [];

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : null;

      if (method === "GET" && url.endsWith("/pulls/42")) {
        return new Response(
          JSON.stringify({
            number: 42,
            title: "feat: double before add",
            body: "Doubles input before adding 1.",
            user: { login: "alice" },
            head: { ref: "pr-42", sha: prHeadSha },
            base: { ref: "main", sha: baseSha },
            html_url: "https://github.com/tikv/sample-rust/pull/42",
            updated_at: "2026-11-22T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (method === "GET" && url.includes("/issues/42/comments")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST" && url.includes("/issues/42/comments")) {
        postedComments.push(body as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 9001 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && url.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "skull", id: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && url.includes("/pulls/42/reviews")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST" && url.includes("/pulls/42/reviews")) {
        postedReviews.push(body as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 9002, state: "PENDING" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected GitHub request: ${method} ${url}`);
    };

    const githubClient = new GitHubClient({
      token: "fake-token",
      fetch: mockFetch as typeof fetch,
    });

    const commitDir = join(repoDir, ".peer", "42", prHeadSha.slice(0, 7));

    // ─── STAGE 1: peer analyze 42 (0 LLM calls) ───
    let analyzeLensCalled = false;
    const analyzeCode = await runCli(["analyze", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
      lensRunner: async () => {
        analyzeLensCalled = true;
        throw new Error("analyze stage must never call lensRunner");
      },
    });
    expect(analyzeCode).toBe(0);
    expect(analyzeLensCalled).toBe(false);
    expect(await Bun.file(join(commitDir, "01-analyze", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "01-analyze", "context.json")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "01-analyze", "tools", "clippy.json")).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(commitDir, "01-analyze", "tools", "audit.json")).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(commitDir, "01-analyze", "tools", "symbol-graph.json")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(commitDir, "review.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "run.json")).exists()).toBe(true);
    expect(runGit(repoDir, ["status", "--porcelain"])).toBe("");

    // ─── STAGE 2: peer review 42 (reuses 01-analyze, runs LLM + cargo check verifier) ───
    let reviewLensCalls = 0;
    const reviewCode = await runCli(["review", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
      lensRunner: async (context) => {
        reviewLensCalls += 1;
        expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(prHeadSha);
        expect(context.pr.number).toBe(42);
        return {
          walkthrough: {
            summary: "Doubles `x` before adding `1` in `calculate`.",
            changes: [
              {
                layer: 0,
                crateName: "sample_rust",
                filePath: "src/lib.rs",
                summary: "Updates arithmetic in `calculate`.",
              },
            ],
            sequenceDiagram: null,
            triage: {
              reviewEffort: 2,
              mergeRisk: "Low",
              rationale: "Single function arithmetic update.",
            },
          },
          findings: [
            {
              id: "soundness-1",
              filePath: "src/lib.rs",
              startLine: 2,
              endLine: 2,
              severity: "Major",
              type: "Bug",
              title: "Use saturating_mul to prevent integer overflow",
              body: "`x * 2` can overflow on i32::MAX.",
              suggestion: "    let doubled = x.saturating_mul(2);",
              suggestionVerified: false,
              agentPrompt: "Replace x * 2 with x.saturating_mul(2).",
              confidence: 0.95,
              source: "soundness",
            },
            {
              id: "idioms-1",
              filePath: "src/lib.rs",
              startLine: 3,
              endLine: 3,
              severity: "Major",
              type: "Idioms",
              title: "Broken suggestion test",
              body: "Proposes a suggestion that does not compile.",
              suggestion: '    let result: i32 = "invalid_type";',
              suggestionVerified: false,
              agentPrompt: "Check line 3 arithmetic.",
              confidence: 0.91,
              source: "idioms",
            },
          ],
        };
      },
    });
    expect(reviewCode).toBe(0);
    expect(reviewLensCalls).toBe(1);
    expect(await Bun.file(join(commitDir, "02-review", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "02-review", "walkthrough.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "02-review", "bundle.json")).exists()).toBe(true);

    // ─── STAGE 3: peer verify 42 (reuses 02-review with 0 lens calls, runs skeptic) ───
    let skepticCalls = 0;
    const verifyCode = await runCli(["verify", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
      lensRunner: async () => {
        throw new Error(
          "verify stage must reuse cached 02-review bundle without calling lensRunner",
        );
      },
      skepticRunner: async (_root, candidates) => {
        skepticCalls += 1;
        // Keep soundness-1, keep idioms-1 too so we can assert compiler-verification stripping below
        return {
          keptFindings: [...candidates],
          rejectedItems: [],
        };
      },
    });
    expect(verifyCode).toBe(0);
    expect(skepticCalls).toBe(1);
    expect(await Bun.file(join(commitDir, "03-verify", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "03-verify", "skeptic.json")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "03-verify", "bundle.json")).exists()).toBe(true);

    // Re-running `peer verify 42` without `--fresh` short-circuits immediately
    const secondOut: string[] = [];
    const secondVerifyCode = await runCli(["verify", "42", "--repo", repoDir], {
      githubClient,
      stdout: (t) => secondOut.push(t),
      skepticRunner: async () => {
        throw new Error("Should short-circuit when stage verify is already completed");
      },
    });
    expect(secondVerifyCode).toBe(0);
    expect(secondOut.join("\n")).toContain("Already completed stage `verify`");

    // ─── STAGE 4: peer publish 42 (0 builds, 0 LLM calls, uploads saved Stage 3 bundle) ───
    const publishCode = await runCli(["publish", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
      lensRunner: async () => {
        throw new Error("publish stage must never run lensRunner");
      },
    });
    expect(publishCode).toBe(0);
    expect(await Bun.file(join(commitDir, "04-publish", "report.md")).exists()).toBe(true);
    expect(
      await Bun.file(join(repoDir, ".git", "peer", "reviews", "pr-42", "checkpoint.json")).exists(),
    ).toBe(true);

    // Original symbolic branch "main" and baseSha are restored & working tree is clean
    expect(runGit(repoDir, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(runGit(repoDir, ["status", "--porcelain"])).toBe("");

    // GitHub walkthrough comment and PENDING review were posted with verified suggestion
    expect(postedComments.length).toBe(1);
    expect(postedReviews.length).toBe(1);
    const reviewPayload = postedReviews[0];
    expect(reviewPayload).toBeDefined();
    expect("event" in (reviewPayload ?? {})).toBe(false);

    const reviewComments = (reviewPayload?.comments ?? []) as Array<{
      line: number;
      body: string;
    }>;
    expect(reviewComments.length).toBe(2);

    const line2Comment = reviewComments.find((c) => c.line === 2);
    const line3Comment = reviewComments.find((c) => c.line === 3);
    expect(line2Comment?.body).toContain("```suggestion");
    expect(line2Comment?.body).toContain("saturating_mul(2)");
    expect(line3Comment?.body).not.toContain("```suggestion");
    expect(line3Comment?.body).toContain("Compiler verification note");
  });

  test("runCli refuses dirty working tree before network or checkout", async () => {
    const { repoDir, baseSha } = await createTempRustGitRepo();

    await writeFile(join(repoDir, "src", "lib.rs"), "// dirty uncommitted edit\n");

    let networkCalled = false;
    const mockFetch = async (_input: string | URL | Request): Promise<Response> => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    };

    const stderrChunks: string[] = [];
    const exitCode = await runCli(["review", "42", "--repo", repoDir], {
      githubClient: new GitHubClient({
        token: "fake",
        fetch: mockFetch as unknown as typeof fetch,
      }),
      stderr: (text) => stderrChunks.push(text),
    });

    expect(exitCode).toBe(1);
    expect(networkCalled).toBe(false);
    expect(stderrChunks.join("\n")).toContain("src/lib.rs");
    expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(baseSha);
  });

  test("F-03: runCli uses 3-dot merge-base diff so commits added to main after PR branched do not appear as reverted in PR diff", async () => {
    const { repoDir, baseSha, prHeadSha } = await createTempRustGitRepo();

    await writeFile(
      join(repoDir, "Cargo.toml"),
      `[package]\nname = "sample_rust"\nversion = "0.2.0"\nedition = "2021"\n`,
    );
    runGit(repoDir, ["add", "Cargo.toml"]);
    runGit(repoDir, ["commit", "-m", "chore(main): bump version on main after PR branched"]);
    const advancedMainSha = runGit(repoDir, ["rev-parse", "HEAD"]);
    expect(advancedMainSha).not.toBe(baseSha);

    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/pulls/42")) {
        return new Response(
          JSON.stringify({
            number: 42,
            title: "feat: double before add",
            body: "Doubles input.",
            user: { login: "alice" },
            head: { ref: "pr-42", sha: prHeadSha },
            base: { ref: "main", sha: advancedMainSha },
            html_url: "https://github.com/tikv/sample-rust/pull/42",
            updated_at: "2026-11-22T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected GitHub call: ${url}`);
    };

    let observedDiffFiles: string[] = [];
    const exitCode = await runCli(["review", "42", "--repo", repoDir], {
      githubClient: new GitHubClient({
        token: "fake",
        fetch: mockFetch as unknown as typeof fetch,
      }),
      stdout: () => {},
      lensRunner: async (ctx) => {
        observedDiffFiles = Object.keys(ctx.diffMap);
        return {
          walkthrough: {
            summary: "Clean.",
            changes: [],
            sequenceDiagram: null,
            triage: { reviewEffort: 1, mergeRisk: "Low", rationale: "Small" },
          },
          findings: [],
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(observedDiffFiles).toEqual(["src/lib.rs"]);
  });

  test("supports 'peer learn add/list/remove', parses --tools, and rejects --submit outside publish", async () => {
    const { repoDir } = await createTempRustGitRepo();

    expect(Array.from(parseToolsOption("deny,geiger")).sort()).toEqual(["deny", "geiger"]);
    expect(parseToolsOption("all").size).toBe(5);
    expect(() => parseToolsOption("unknown_tool")).toThrow('Unknown tool "unknown_tool"');

    const out: string[] = [];
    const err: string[] = [];

    const badSubmitCode = await runCli(["review", "42", "--submit", "--repo", repoDir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(badSubmitCode).toBe(1);
    expect(err.join("\n")).toContain("--submit is only valid with `peer publish`");

    out.length = 0;
    const addCode = await runCli(
      [
        "learn",
        "add",
        "Prefer parking_lot::Mutex in OMS",
        "--scope",
        "src/oms/**",
        "--repo",
        repoDir,
      ],
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    );
    expect(addCode).toBe(0);
    expect(out.join("\n")).toContain("Added learning [");

    out.length = 0;
    const listCode = await runCli(["learn", "list", "--repo", repoDir], {
      stdout: (t) => out.push(t),
    });
    expect(listCode).toBe(0);
    const listedText = out.join("\n");
    expect(listedText).toContain("Prefer parking_lot::Mutex in OMS");
    const idMatch = /^\[([a-f0-9]+)\]/.exec(listedText.trim());
    const id = idMatch?.[1] ?? "";
    expect(id.length).toBeGreaterThan(0);

    out.length = 0;
    const rmCode = await runCli(["learn", "remove", id, "--repo", repoDir], {
      stdout: (t) => out.push(t),
    });
    expect(rmCode).toBe(0);
    expect(out.join("\n")).toContain(`Removed learning [${id}]`);
  });

  test("fails fast without origin remote and exits 2 on partial cohort failure blocking publish", async () => {
    const { repoDir, baseSha, prHeadSha } = await createTempRustGitRepo();

    runGit(repoDir, ["remote", "remove", "origin"]);
    let listPrsCalled = false;
    const errOut: string[] = [];
    const noOriginCode = await runCli(["review", "--repo", repoDir], {
      githubClient: {
        listOpenPrs: async () => {
          listPrsCalled = true;
          return [];
        },
      } as unknown as GitHubClient,
      stderr: (t) => errOut.push(t),
    });
    expect(noOriginCode).toBe(1);
    expect(listPrsCalled).toBe(false);
    expect(errOut.join("\n")).toContain("Unable to determine GitHub repository owner/name");

    runGit(repoDir, ["remote", "add", "origin", "https://github.com/tikv/sample-rust.git"]);
    let reviewPosted = false;
    const mockGh = {
      getPullRequest: async () => ({
        owner: "tikv",
        repo: "sample-rust",
        number: 42,
        title: "feat: partial test",
        body: "",
        author: "alice",
        headRefName: "pr-42",
        baseRefName: "main",
        headSha: prHeadSha,
        baseSha,
        htmlUrl: "https://github.com/tikv/sample-rust/pull/42",
        updatedAt: "2026-11-22T00:00:00Z",
      }),
      upsertWalkthroughComment: async () => {
        reviewPosted = true;
        return 1;
      },
      postPrReview: async () => {
        reviewPosted = true;
        return 2;
      },
    } as unknown as GitHubClient;

    const partialReviewCode = await runCli(["review", "42", "--repo", repoDir], {
      githubClient: mockGh,
      stdout: () => {},
      stderr: (t) => errOut.push(t),
      lensRunner: async () => ({
        walkthrough: {
          summary: "Partial review.",
          changes: [],
          sequenceDiagram: null,
          triage: { reviewEffort: 1, mergeRisk: "Low", rationale: "test" },
        },
        findings: [],
        failedCohorts: ["peer-cohort-1 (1/2: src)"],
      }),
    });
    expect(partialReviewCode).toBe(2);

    // Attempting `peer publish 42` without `--allow-partial` must also exit 2 without posting!
    const blockedPublishCode = await runCli(["publish", "42", "--repo", repoDir], {
      githubClient: mockGh,
      stdout: () => {},
      stderr: (t) => errOut.push(t),
    });
    expect(blockedPublishCode).toBe(2);
    expect(reviewPosted).toBe(false);
  });
});
