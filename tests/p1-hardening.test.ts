import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSensitiveFiles } from "../src/domain/diff.ts";
import { type CrateGraph, type DiffFileMap, FindingSchema } from "../src/domain/models.ts";
import { partitionAndFilterFindings } from "../src/judge/partition.ts";
import { SuggestionCompilerVerifier } from "../src/judge/verifier.ts";
import { InPlaceCheckoutSession, restoreInterruptedSession } from "../src/workspace/git.ts";

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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("v0.2 Batch 2 P1 hardening", () => {
  test("findSensitiveFiles flags toolchain, cargo config, CI workflows, deny.toml, and .proto files", () => {
    const flagged = findSensitiveFiles([
      "src/lib.rs",
      ".cargo/config.toml",
      "rust-toolchain.toml",
      ".github/workflows/ci.yml",
      "deny.toml",
      "proto/order.proto",
      "README.md",
    ]);
    expect(flagged).toEqual([
      ".cargo/config.toml",
      ".github/workflows/ci.yml",
      "deny.toml",
      "proto/order.proto",
      "rust-toolchain.toml",
    ]);
  });

  test("clusterOverlappingFindings keeps two distinct LLM findings on overlapping lines separate", () => {
    const diffMap: Record<string, DiffFileMap> = {
      "src/lib.rs": {
        filePath: "src/lib.rs",
        hunks: [
          {
            oldStart: 1,
            oldCount: 5,
            newStart: 1,
            newEnd: 10,
            header: "@@ -1,5 +1,10 @@",
            annotatedLines: [],
            rightSideLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          },
        ],
      },
    };

    const f1 = FindingSchema.parse({
      id: "fp-aaa",
      filePath: "src/lib.rs",
      startLine: 2,
      endLine: 5,
      severity: "Critical",
      type: "Concurrency",
      title: "MutexGuard held across .await",
      rootCause: "std::sync::Mutex lock held across await",
      body: "Deadlocks async executor.",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Drop lock before await.",
      confidence: 0.95,
      source: "soundness",
    });

    const f2 = FindingSchema.parse({
      id: "fp-bbb",
      filePath: "src/lib.rs",
      startLine: 3,
      endLine: 4,
      severity: "Major",
      type: "Bug",
      title: "Integer overflow in balance calculation",
      rootCause: "unchecked multiplication on u64",
      body: "Can wrap in release mode.",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Use checked_mul.",
      confidence: 0.9,
      source: "soundness",
    });

    const partitioned = partitionAndFilterFindings([f1, f2], diffMap, "assertive");
    expect(partitioned.inlineFindings.length).toBe(2);
  });

  test("SuggestionCompilerVerifier scopes cargo check to -p <crate> and diffs against baseline errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-verif-p1-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "crates", "core", "src"), { recursive: true });
    await writeFile(join(dir, "crates", "core", "src", "lib.rs"), "pub fn f() -> i32 { 1 }\n");

    const seenPackages: Array<string | undefined> = [];
    let callCount = 0;
    const verifier = new SuggestionCompilerVerifier({
      checkRunner: async (_root, pkg) => {
        seenPackages.push(pkg);
        callCount += 1;
        // Call 1 = baseline check (has pre-existing E0425), Call 2 = patched check (same E0425 only -> PASS!)
        return {
          ok: false,
          errorSummary: "[E0425] cannot find value `preexisting`",
          errorMessages: ["[E0425] cannot find value `preexisting`"],
        };
      },
    });

    const crateGraph: CrateGraph = {
      crates: {
        core: {
          name: "core",
          manifestDir: "crates/core",
          layer: 0,
          dependencies: [],
        },
      },
      testLayer: 1,
    };

    const finding = FindingSchema.parse({
      id: "fp-123",
      filePath: "crates/core/src/lib.rs",
      startLine: 1,
      endLine: 1,
      severity: "Major",
      type: "Bug",
      title: "Return 2",
      body: "Fix return value.",
      suggestion: "pub fn f() -> i32 { 2 }",
      suggestionVerified: false,
      agentPrompt: "Return 2.",
      confidence: 0.95,
      source: "soundness",
    });

    const verified = await verifier.verifySuggestions(dir, [finding], undefined, {
      crateGraph,
      baselineErrorCount: 1,
    });

    expect(callCount).toBe(2);
    expect(seenPackages).toEqual(["core", "core"]);
    expect(verified[0]?.suggestionVerified).toBe(true);
    expect(verified[0]?.suggestion).toBe("pub fn f() -> i32 { 2 }");
  });

  test("restoreInterruptedSession recovers original branch from .git/peer/session.json after crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-restore-p1-"));
    tempDirs.push(dir);
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Tester"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);
    await writeFile(join(dir, "a.txt"), "v1\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "c1"]);

    runGit(dir, ["checkout", "-b", "pr-branch"]);
    await writeFile(join(dir, "a.txt"), "v2\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "c2"]);
    const prSha = runGit(dir, ["rev-parse", "HEAD"]);
    runGit(dir, ["checkout", "main"]);

    // Enter session without calling exit() to simulate SIGKILL
    const session = new InPlaceCheckoutSession({ repoRoot: dir, targetSha: prSha });
    await session.enter();
    expect(runGit(dir, ["rev-parse", "HEAD"])).toBe(prSha);

    const restored = await restoreInterruptedSession(dir);
    expect(restored.restored).toBe(true);
    expect(restored.originalRef).toBe("main");
    expect(runGit(dir, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
  });
});
