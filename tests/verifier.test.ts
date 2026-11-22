import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
