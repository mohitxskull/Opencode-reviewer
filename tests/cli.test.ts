import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
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

describe("Task 07: End-to-end peer CLI pipeline", () => {
  test("runCli reviews Rust PR end-to-end, verifies suggestions with cargo check, writes artifacts, and posts PENDING review", async () => {
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

    const stdoutChunks: string[] = [];
    const exitCode = await runCli(["review", "42", "--post", "--repo", repoDir], {
      githubClient,
      stdout: (text) => stdoutChunks.push(text),
      lensRunner: async (context) => {
        // Confirm that while lensRunner executes, the PR head commit is checked out!
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
            // Finding 1: Valid compiling suggestion on line 2
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
            // Finding 2: Broken non-compiling suggestion on line 3
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

    expect(exitCode).toBe(0);

    // 1. Original symbolic branch "main" and baseSha are restored
    expect(runGit(repoDir, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(runGit(repoDir, ["status", "--porcelain"])).toBe("");

    // 2. Local artifacts exist inside .git/peer/reviews/pr-42/
    const reviewDir = join(repoDir, ".git", "peer", "reviews", "pr-42");
    expect(await Bun.file(join(reviewDir, "walkthrough.md")).exists()).toBe(true);
    expect(await Bun.file(join(reviewDir, "findings.json")).exists()).toBe(true);
    expect(await Bun.file(join(reviewDir, "review.md")).exists()).toBe(true);
    expect(await Bun.file(join(reviewDir, "checkpoint.json")).exists()).toBe(true);

    // 3. GitHub walkthrough comment and PENDING review were posted
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
    // Non-compiling suggestion on line 3 was stripped by cargo check!
    expect(line3Comment?.body).not.toContain("```suggestion");
    expect(line3Comment?.body).toContain("Compiler verification note");
  });

  test("runCli refuses dirty working tree before network or checkout", async () => {
    const { repoDir, baseSha } = await createTempRustGitRepo();

    // Dirty the tracked file
    await writeFile(join(repoDir, "src", "lib.rs"), "// dirty uncommitted edit\n");

    let networkCalled = false;
    const mockFetch = async (_input: string | URL | Request): Promise<Response> => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    };

    const stderrChunks: string[] = [];
    const exitCode = await runCli(["review", "42", "--local-only", "--repo", repoDir], {
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

    // Advance main by modifying an existing file (`Cargo.toml`) AFTER pr-42 branched off `baseSha`
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
            // GitHub reports base.sha as the current tip of main (advancedMainSha)
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
    const exitCode = await runCli(["review", "42", "--local-only", "--repo", repoDir], {
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
    // Only src/lib.rs from pr-42 should be in diffMap, NOT src/unrelated_on_main.rs
    expect(observedDiffFiles).toEqual(["src/lib.rs"]);
  });

  test("F-15 & F-16: runCli supports 'peer learn add/list/remove' subcommands and rejects conflicting --post --local-only flags", async () => {
    const { repoDir } = await createTempRustGitRepo();

    const out: string[] = [];
    const err: string[] = [];

    // 1. Conflicting --post and --local-only flags
    const conflictCode = await runCli(
      ["review", "42", "--post", "--local-only", "--repo", repoDir],
      {
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
      },
    );
    expect(conflictCode).toBe(1);
    expect(err.join("\n")).toContain("Cannot combine --post and --local-only");

    // 2. peer learn add -> list -> remove
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
    const addedLine = out.join("\n");
    expect(addedLine).toContain("Added learning [");

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
});
