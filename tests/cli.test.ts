import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToolsOption, runCli } from "../src/cli/index.ts";
import { GitHubClient } from "../src/github/client.ts";

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

describe("End-to-end agent-agnostic peer CLI pipeline", () => {
  test("analyze -> finalize (with cargo check suggestion verification) -> publish works end-to-end with zero LLM SDK", async () => {
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

    // ─── STAGE 1: peer analyze 42 ───
    const analyzeCode = await runCli(["analyze", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
    });
    expect(analyzeCode).toBe(0);
    expect(await Bun.file(join(commitDir, "01-analyze", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "01-analyze", "context.json")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "01-analyze", "prompt-context.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "01-analyze", "tools", "clippy.json")).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(commitDir, "01-analyze", "tools", "audit.json")).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(commitDir, "01-analyze", "tools", "symbol-graph.json")).exists(),
    ).toBe(true);
    expect(runGit(repoDir, ["status", "--porcelain"])).toBe("");

    // Re-running `peer analyze 42` without `--fresh` short-circuits immediately
    const secondOut: string[] = [];
    const secondAnalyzeCode = await runCli(["analyze", "42", "--repo", repoDir], {
      githubClient,
      stdout: (t) => secondOut.push(t),
    });
    expect(secondAnalyzeCode).toBe(0);
    expect(secondOut.join("\n")).toContain("Already analyzed PR #42");

    // ─── STAGE 2: peer finalize 42 --from <agent-findings.md> ───
    const agentOutputPath = join(commitDir, "agent-findings.md");
    await writeFile(
      agentOutputPath,
      [
        "## FINDINGS",
        "",
        "### FINDING",
        "- File: src/lib.rs",
        "- Lines: 2-2",
        "- Severity: Major",
        "- Type: Bug",
        "- Confidence: 0.95",
        "- Title: Use saturating_mul to prevent integer overflow",
        "- Body: `x * 2` can overflow on `i32::MAX`.",
        "- AgentPrompt: Replace `x * 2` with `x.saturating_mul(2)`.",
        "#### Suggestion",
        "```rust",
        "    let doubled = x.saturating_mul(2);",
        "```",
        "",
        "### FINDING",
        "- File: src/lib.rs",
        "- Lines: 3-3",
        "- Severity: Major",
        "- Type: Idioms",
        "- Confidence: 0.91",
        "- Title: Broken suggestion test",
        "- Body: Proposes a suggestion that does not compile.",
        "- AgentPrompt: Check line 3 arithmetic.",
        "#### Suggestion",
        "```rust",
        '    let result: i32 = "invalid_type";',
        "```",
        "",
      ].join("\n"),
    );

    const finalizeCode = await runCli(
      ["finalize", "42", "--from", agentOutputPath, "--repo", repoDir],
      {
        githubClient,
        stdout: () => {},
      },
    );
    expect(finalizeCode).toBe(0);
    expect(await Bun.file(join(commitDir, "02-review", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "02-review", "bundle.json")).exists()).toBe(true);

    // ─── STAGE 3: peer finalize --verdicts (deterministic skeptic filtering) ───
    const stage2Bundle = (await Bun.file(join(commitDir, "02-review", "bundle.json")).json()) as {
      findings: Array<{ id: string }>;
    };
    const fpIds = stage2Bundle.findings.map((f) => f.id);
    expect(fpIds.every((id) => id.startsWith("fp-"))).toBe(true);

    const verdictsPath = join(commitDir, "skeptic-verdicts.md");
    await writeFile(
      verdictsPath,
      ["## VERDICTS", ...fpIds.map((id) => `- ${id} | KEEP | Verified during skeptic check`)].join(
        "\n",
      ),
    );
    const verifyCode = await runCli(
      ["finalize", "42", "--verdicts", verdictsPath, "--repo", repoDir],
      {
        githubClient,
        stdout: () => {},
      },
    );
    expect(verifyCode).toBe(0);
    expect(await Bun.file(join(commitDir, "03-verify", "report.md")).exists()).toBe(true);
    expect(await Bun.file(join(commitDir, "03-verify", "skeptic.json")).exists()).toBe(true);

    // ─── STAGE 4: peer publish 42 ───
    const publishCode = await runCli(["publish", "42", "--repo", repoDir], {
      githubClient,
      stdout: () => {},
    });
    expect(publishCode).toBe(0);
    expect(await Bun.file(join(commitDir, "04-publish", "report.md")).exists()).toBe(true);
    expect(
      await Bun.file(join(repoDir, ".git", "peer", "reviews", "pr-42", "checkpoint.json")).exists(),
    ).toBe(true);

    expect(runGit(repoDir, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(baseSha);
    expect(runGit(repoDir, ["status", "--porcelain"])).toBe("");

    expect(postedComments.length).toBe(1);
    expect(postedReviews.length).toBe(1);
    const reviewComments = (postedReviews[0]?.comments ?? []) as Array<{
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
    const mockFetch = async (): Promise<Response> => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    };

    const stderrChunks: string[] = [];
    const exitCode = await runCli(["analyze", "42", "--repo", repoDir], {
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

  test("supports 'peer learn add/list/remove', parses --tools, and validates --submit / --from", async () => {
    const { repoDir } = await createTempRustGitRepo();

    expect(Array.from(parseToolsOption("deny,geiger")).sort()).toEqual(["deny", "geiger"]);
    expect(parseToolsOption("all").size).toBe(5);
    expect(() => parseToolsOption("unknown_tool")).toThrow('Unknown tool "unknown_tool"');

    const out: string[] = [];
    const err: string[] = [];

    const badSubmitCode = await runCli(["analyze", "42", "--submit", "--repo", repoDir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(badSubmitCode).toBe(1);
    expect(err.join("\n")).toContain("--submit is only valid with `peer publish`");

    err.length = 0;
    const missingFromCode = await runCli(["finalize", "42", "--repo", repoDir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(missingFromCode).toBe(1);
    expect(err.join("\n")).toContain("requires `--from <file>`");

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

    // peer doctor runs cleanly and prints toolchain table
    out.length = 0;
    const doctorCode = await runCli(["doctor"], {
      stdout: (t) => out.push(t),
    });
    expect(doctorCode).toBe(0);
    expect(out.join("\n")).toContain("peer doctor");
    expect(out.join("\n")).toContain("cargo-audit");

    // peer prompt returns embedded lens prompts and rejects unknown names
    out.length = 0;
    const promptCode = await runCli(["prompt", "soundness"], {
      stdout: (t) => out.push(t),
    });
    expect(promptCode).toBe(0);
    expect(out.join("\n")).toContain("FINDING");

    err.length = 0;
    const badPromptCode = await runCli(["prompt", "nonexistent"], {
      stderr: (t) => err.push(t),
    });
    expect(badPromptCode).toBe(1);
    expect(err.join("\n")).toContain('Unknown prompt "nonexistent"');
  });
});
