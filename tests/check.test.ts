import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";

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

describe("v0.3 local deterministic gate (peer check + baseline + SARIF + AST detectors)", () => {
  test("peer check runs with zero GitHub remote/token, detects undocumented unsafe & prod unwrap (skipping #[cfg(test)]), emits SARIF, and ratchets via baseline.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-check-v03-"));
    tempDirs.push(dir);

    // Note: NO `origin` remote and NO GitHub token!
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Local Dev"]);
    runGit(dir, ["config", "user.email", "dev@local"]);

    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "/target\n");
    await writeFile(
      join(dir, "Cargo.toml"),
      `[package]\nname = "gate_demo"\nversion = "0.1.0"\nedition = "2021"\n`,
    );
    await writeFile(join(dir, "src", "lib.rs"), `pub fn ok() -> i32 { 1 }\n`);
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "base"]);

    // Feature branch adds undocumented unsafe, prod .unwrap(), and a #[cfg(test)] .unwrap() (which must be ignored!)
    runGit(dir, ["checkout", "-b", "feat-gate"]);
    await writeFile(
      join(dir, "src", "lib.rs"),
      [
        "pub fn ok() -> i32 { 1 }",
        "",
        "pub fn risky(ptr: *const i32, opt: Option<i32>) -> i32 {",
        "    let val = opt.unwrap();",
        "    unsafe { *ptr + val }",
        "}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    #[test]",
        "    fn test_unwrap_is_allowed() {",
        "        let v: Option<i32> = std::hint::black_box(Some(1));",
        "        let _ = v.unwrap();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    runGit(dir, ["add", "src/lib.rs"]);
    runGit(dir, ["commit", "-m", "feat: add risky fn"]);

    const sarifPath = join(dir, "peer-results.sarif");
    const out1: string[] = [];
    const code1 = await runCli(["check", "--base", "main", "--sarif", sarifPath, "--repo", dir], {
      stdout: (t) => out1.push(t),
    });

    // Major finding (undocumented unsafe) triggers exit code 1
    expect(code1).toBe(1);
    const out1Text = out1.join("\n");
    expect(out1Text).toContain("New `unsafe` block/item without `// SAFETY:`");
    expect(out1Text).toContain("Production panic call `.unwrap()`");

    // Verify SARIF 2.1.0 output is valid and does NOT flag line 12 inside #[cfg(test)]
    const sarif = (await Bun.file(sarifPath).json()) as {
      version: string;
      runs: Array<{
        results: Array<{
          locations: Array<{ physicalLocation: { region: { startLine: number } } }>;
        }>;
      }>;
    };
    expect(sarif.version).toBe("2.1.0");
    const flaggedLines = sarif.runs[0]?.results.map(
      (r) => r.locations[0]?.physicalLocation.region.startLine,
    );
    expect(flaggedLines).toContain(4);
    expect(flaggedLines).toContain(5);
    expect(flaggedLines).not.toContain(13);

    // Update baseline -> exits 0 and writes .peer/baseline.json
    const out2: string[] = [];
    const code2 = await runCli(["check", "--base", "main", "--update-baseline", "--repo", dir], {
      stdout: (t) => out2.push(t),
    });
    expect(code2).toBe(0);
    expect(await Bun.file(join(dir, ".peer", "baseline.json")).exists()).toBe(true);

    // Re-running `peer check` now passes (0 new findings, all baselined)
    const out3: string[] = [];
    const code3 = await runCli(["check", "--base", "main", "--repo", dir], {
      stdout: (t) => out3.push(t),
    });
    expect(code3).toBe(0);
    expect(out3.join("\n")).toContain("0 new finding(s)");
  }, 30_000);
});
