import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InPlaceCheckoutSession } from "../src/git.ts";
import type { Finding } from "../src/models.ts";
import { SuggestionCompilerVerifier } from "../src/verifier.ts";

const tempDirs: string[] = [];

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createTempCargoCrate(): Promise<{
  dir: string;
  filePath: string;
  origHash: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "peer-verifier-crate-"));
  tempDirs.push(dir);

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "Cargo.toml"),
    `[package]\nname = "verifier_crate"\nversion = "0.1.0"\nedition = "2021"\n`,
  );

  const rustSource = [
    "pub fn add_numbers(a: i32, b: i32) -> i32 {",
    "    let sum = a + b;",
    "    sum",
    "}",
    "",
  ].join("\n");

  const fullPath = join(dir, "src", "lib.rs");
  await writeFile(fullPath, rustSource);
  const origBytes = await Bun.file(fullPath).bytes();

  return {
    dir,
    filePath: fullPath,
    origHash: sha256Bytes(origBytes),
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Task 06: Transactional suggestion compiler verifier (cargo check)", () => {
  test("verifySuggestions keeps valid compiling Rust suggestion and restores exact file bytes", async () => {
    const { dir, filePath, origHash } = await createTempCargoCrate();

    const validFinding: Finding = {
      id: "f-valid",
      filePath: "src/lib.rs",
      startLine: 2,
      endLine: 3,
      severity: "Minor",
      type: "Idioms",
      title: "Use saturating_add",
      body: "Prevent overflow with saturating_add.",
      suggestion: "    a.saturating_add(b)",
      suggestionVerified: false,
      agentPrompt: "Replace addition with saturating_add.",
      confidence: 0.9,
      source: "idioms",
    };

    const verifier = new SuggestionCompilerVerifier();
    const verified = await verifier.verifySuggestions(dir, [validFinding]);

    expect(verified.length).toBe(1);
    expect(verified[0]?.suggestionVerified).toBe(true);
    expect(verified[0]?.suggestion).toBe("    a.saturating_add(b)");

    const afterBytes = await Bun.file(filePath).bytes();
    expect(sha256Bytes(afterBytes)).toBe(origHash);
  });

  test("verifySuggestions strips non-compiling Rust suggestion and records compiler error in agentPrompt", async () => {
    const { dir, filePath, origHash } = await createTempCargoCrate();

    const brokenFinding: Finding = {
      id: "f-broken",
      filePath: "src/lib.rs",
      startLine: 2,
      endLine: 3,
      severity: "Major",
      type: "Bug",
      title: "Bad return type suggestion",
      body: "Hallucinated string return.",
      suggestion: '    "not_an_i32"',
      suggestionVerified: false,
      agentPrompt: "Fix return value.",
      confidence: 0.9,
      source: "soundness",
    };

    const verifier = new SuggestionCompilerVerifier();
    const verified = await verifier.verifySuggestions(dir, [brokenFinding]);

    expect(verified.length).toBe(1);
    expect(verified[0]?.suggestion).toBeNull();
    expect(verified[0]?.suggestionVerified).toBe(false);
    expect(verified[0]?.agentPrompt).toContain("Compiler verification note");

    const afterBytes = await Bun.file(filePath).bytes();
    expect(sha256Bytes(afterBytes)).toBe(origHash);
  });

  test("verifySuggestions restores original file bytes when check runner throws mid-flight", async () => {
    const { dir, filePath, origHash } = await createTempCargoCrate();

    const finding: Finding = {
      id: "f-throw",
      filePath: "src/lib.rs",
      startLine: 2,
      endLine: 2,
      severity: "Major",
      type: "Bug",
      title: "Mid-flight crash",
      body: "Test byte restoration when runner throws.",
      suggestion: "    let sum = a.wrapping_add(b);",
      suggestionVerified: false,
      agentPrompt: "Use wrapping_add.",
      confidence: 0.9,
      source: "soundness",
    };

    const verifier = new SuggestionCompilerVerifier({
      checkRunner: async () => {
        // Verify the patched file is actually on disk when checkRunner executes
        const midBytes = await Bun.file(filePath).bytes();
        expect(sha256Bytes(midBytes)).not.toBe(origHash);
        throw new Error("Simulated cargo check crash");
      },
    });

    await expect(verifier.verifySuggestions(dir, [finding])).rejects.toThrow(
      "Simulated cargo check crash",
    );

    const afterBytes = await Bun.file(filePath).bytes();
    expect(sha256Bytes(afterBytes)).toBe(origHash);
  });

  test("F-01: verifySuggestions rejects path traversal (../) and symlinks pointing outside repoRoot without modifying external files", async () => {
    const { dir } = await createTempCargoCrate();
    const externalDir = await mkdtemp(join(tmpdir(), "peer-external-secret-"));
    tempDirs.push(externalDir);

    const externalFile = join(externalDir, "outside.rs");
    const externalContent = "pub fn secret_host_file() {}\n";
    await writeFile(externalFile, externalContent);
    const externalOrigHash = sha256Bytes(await Bun.file(externalFile).bytes());

    // Create a symlink inside the repo pointing to externalFile
    await symlink(externalFile, join(dir, "src", "symlink_escape.rs"));

    const traversalFinding: Finding = {
      id: "f-traversal",
      filePath: `../${externalDir.split("/").pop()}/outside.rs`,
      startLine: 1,
      endLine: 1,
      severity: "Critical",
      type: "Security",
      title: "Path traversal attempt",
      body: "Attempt to overwrite file outside repoRoot.",
      suggestion: "pub fn pwned() {}",
      suggestionVerified: false,
      agentPrompt: "Do not allow traversal.",
      confidence: 0.99,
      source: "soundness",
    };

    const symlinkFinding: Finding = {
      ...traversalFinding,
      id: "f-symlink",
      filePath: "src/symlink_escape.rs",
    };

    let checkRunnerCalled = false;
    const verifier = new SuggestionCompilerVerifier({
      checkRunner: async () => {
        checkRunnerCalled = true;
        return { ok: true, errorSummary: "" };
      },
    });

    const verified = await verifier.verifySuggestions(dir, [traversalFinding, symlinkFinding]);
    expect(checkRunnerCalled).toBe(false);
    expect(verified[0]?.suggestion).toBeNull();
    expect(verified[0]?.suggestionVerified).toBe(false);
    expect(verified[1]?.suggestion).toBeNull();
    expect(verified[1]?.suggestionVerified).toBe(false);

    // External file must be completely untouched
    const externalAfterHash = sha256Bytes(await Bun.file(externalFile).bytes());
    expect(externalAfterHash).toBe(externalOrigHash);
  });

  test("F-02: LIFO signal cleanup restores verifier patched file bytes BEFORE InPlaceCheckoutSession restores branch", async () => {
    const { dir, filePath, origHash } = await createTempCargoCrate();

    const runGit = (args: string[]) => {
      const res = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.toString());
      }
      return res.stdout.toString().trim();
    };

    runGit(["init", "-b", "main"]);
    runGit(["config", "user.name", "Test"]);
    runGit(["config", "user.email", "test@example.com"]);
    await writeFile(join(dir, ".gitignore"), "/target\n");
    runGit(["add", "."]);
    runGit(["commit", "-m", "base"]);
    const baseSha = runGit(["rev-parse", "HEAD"]);

    runGit(["checkout", "-b", "pr-branch"]);
    const prContent = [
      "pub fn add_numbers(a: i32, b: i32) -> i32 {",
      "    let sum = a + b + 0;",
      "    sum",
      "}",
      "",
    ].join("\n");
    await writeFile(filePath, prContent);
    const prOrigHash = sha256Bytes(await Bun.file(filePath).bytes());
    runGit(["add", "."]);
    runGit(["commit", "-m", "pr commit"]);
    const prHeadSha = runGit(["rev-parse", "HEAD"]);
    runGit(["checkout", "main"]);

    const session = new InPlaceCheckoutSession({ repoRoot: dir, targetSha: prHeadSha });
    await session.enter();

    const finding: Finding = {
      id: "f-sig",
      filePath: "src/lib.rs",
      startLine: 2,
      endLine: 2,
      severity: "Major",
      type: "Bug",
      title: "Signal order test",
      body: "Test signal rollback during checkRunner.",
      suggestion: "    let sum = a.saturating_add(b);",
      suggestionVerified: false,
      agentPrompt: "Use saturating_add.",
      confidence: 0.9,
      source: "soundness",
    };

    let patchedHashBeforeSignal = "";
    const verifier = new SuggestionCompilerVerifier({
      checkRunner: async () => {
        patchedHashBeforeSignal = sha256Bytes(await Bun.file(filePath).bytes());
        // Simulate signal firing while patched bytes are on disk:
        // LIFO cleanup restores `prOrigHash` first, then `git checkout -f main` restores `origHash`.
        session.restoreOnSignal();
        return { ok: true, errorSummary: "" };
      },
    });

    await verifier.verifySuggestions(dir, [finding]);
    await session.exit();

    expect(patchedHashBeforeSignal).not.toBe(prOrigHash);
    expect(runGit(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(runGit(["rev-parse", "HEAD"])).toBe(baseSha);
    expect(sha256Bytes(await Bun.file(filePath).bytes())).toBe(origHash);
  });
});
