import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectAstDeterministicFindings } from "../src/analyzers/ast-detectors.ts";
import { runCli } from "../src/cli/index.ts";
import { parseUnifiedDiff } from "../src/domain/diff.ts";
import { isRustTestOrBenchPath } from "../src/domain/paths.ts";

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
        "mod tests;",
        "",
        "#[cfg(test)]",
        "mod inline_tests {",
        "    #[test]",
        "    fn test_unwrap_is_allowed() {",
        "        let v: Option<i32> = std::hint::black_box(Some(1));",
        "        let _ = v.unwrap();",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "src", "tests.rs"),
      [
        "#[test]",
        "fn sibling_test_module_expect_is_allowed() {",
        "    let v: Option<i32> = std::hint::black_box(Some(2));",
        '    let _ = v.expect("test assertion");',
        "}",
        "",
      ].join("\n"),
    );
    runGit(dir, ["add", "src/lib.rs", "src/tests.rs"]);
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
    expect(flaggedLines).not.toContain(16);
    expect(out1Text).not.toContain("src/tests.rs");

    // Update baseline -> exits 0 and writes .peer/baseline.json
    const out2: string[] = [];
    const code2 = await runCli(["check", "--base", "main", "--update-baseline", "--repo", dir], {
      stdout: (t) => out2.push(t),
    });
    expect(code2).toBe(0);
    expect(await Bun.file(join(dir, ".peer", "baseline.json")).exists()).toBe(true);

    // F-01: Poisoning .peer/baseline.json on the PR branch MUST NOT bypass the gate (baseline is loaded from baseSha)
    const outPoison: string[] = [];
    const codePoison = await runCli(["check", "--base", "main", "--repo", dir], {
      stdout: (t) => outPoison.push(t),
    });
    expect(codePoison).toBe(1);
    expect(outPoison.join("\n")).toContain("New `unsafe` block/item without `// SAFETY:`");

    // Once the baseline is committed on the trusted base branch (`main`), re-running `peer check` passes
    const baselineBytes = await Bun.file(join(dir, ".peer", "baseline.json")).text();
    await rm(join(dir, ".peer", "baseline.json"), { force: true });
    runGit(dir, ["checkout", "main"]);
    await mkdir(join(dir, ".peer"), { recursive: true });
    await writeFile(join(dir, ".peer", "baseline.json"), baselineBytes);
    runGit(dir, ["add", "-f", ".peer/baseline.json"]);
    runGit(dir, ["commit", "-m", "chore: commit baseline on main"]);
    runGit(dir, ["checkout", "feat-gate"]);

    const out3: string[] = [];
    const code3 = await runCli(["check", "--base", "main", "--repo", dir], {
      stdout: (t) => out3.push(t),
    });
    expect(code3).toBe(0);
    expect(out3.join("\n")).toContain("0 new finding(s)");
  }, 30_000);

  test("isRustTestOrBenchPath recognizes tests.rs, test.rs, *_test.rs, and tests/benches/examples dirs", () => {
    expect(isRustTestOrBenchPath("src/services/live/oms/tests.rs")).toBe(true);
    expect(isRustTestOrBenchPath("src/services/live/oms/test.rs")).toBe(true);
    expect(isRustTestOrBenchPath("tests.rs")).toBe(true);
    expect(isRustTestOrBenchPath("src/foo_test.rs")).toBe(true);
    expect(isRustTestOrBenchPath("src/foo_tests.rs")).toBe(true);
    expect(isRustTestOrBenchPath("tests/integration.rs")).toBe(true);
    expect(isRustTestOrBenchPath("crates/core/benches/perf.rs")).toBe(true);
    expect(isRustTestOrBenchPath("examples/demo.rs")).toBe(true);
    expect(isRustTestOrBenchPath("src/services/common/ledger.rs")).toBe(false);
    expect(isRustTestOrBenchPath("src/services/contest.rs")).toBe(false);
  });

  test("collectAstDeterministicFindings groups multiple panic calls inside the same function into one finding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-ast-group-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "ledger.rs"),
      [
        "pub fn send_sync(a: Option<i32>, b: Option<i32>) -> i32 {",
        '    let x = a.expect("a missing");',
        '    let y = b.expect("b missing");',
        '    if x < 0 { panic!("negative"); }',
        "    x + y",
        "}",
        "",
      ].join("\n"),
    );

    const diff = [
      "diff --git a/src/ledger.rs b/src/ledger.rs",
      "--- a/src/ledger.rs",
      "+++ b/src/ledger.rs",
      "@@ -0,0 +1,6 @@",
      "+pub fn send_sync(a: Option<i32>, b: Option<i32>) -> i32 {",
      '+    let x = a.expect("a missing");',
      '+    let y = b.expect("b missing");',
      '+    if x < 0 { panic!("negative"); }',
      "+    x + y",
      "+}",
      "",
    ].join("\n");

    const findings = await collectAstDeterministicFindings(dir, parseUnifiedDiff(diff));
    expect(findings.length).toBe(1);
    expect(findings[0]?.title).toContain("3 production panic calls");
    expect(findings[0]?.title).toContain("`send_sync`");
    expect(findings[0]?.body).toContain("L2, L3, L4");
  });

  test("Tier 0: peer check exits 2 (hard error) instead of 0 when git diff merge-base fails (e.g. shallow/disjoint history)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-check-disjoint-"));
    tempDirs.push(dir);
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Local Dev"]);
    runGit(dir, ["config", "user.email", "dev@local"]);
    await writeFile(
      join(dir, "Cargo.toml"),
      `[package]\nname = "d"\nversion = "0.1.0"\nedition = "2021"\n`,
    );
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "main root"]);

    // Create an orphan branch with no common ancestor with `main`
    runGit(dir, ["checkout", "--orphan", "orphan-pr"]);
    await writeFile(join(dir, "README.md"), "disjoint\n");
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "orphan root"]);

    const errs: string[] = [];
    const code = await runCli(["check", "--base", "main", "--repo", dir], {
      stderr: (t) => errs.push(t),
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("fetch-depth: 0");
  });

  test("Tier 0 Fingerprint v2: panics across multiple functions in one file collapse to 1 per-file finding whose fingerprint changes when a new fn panic is added; shifting unsafe line preserves fingerprint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-fp-v2-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });

    await writeFile(
      join(dir, "src", "lib.rs"),
      [
        "pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
        "pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
        "",
      ].join("\n"),
    );

    const diffOnlyAlpha = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -0,0 +1,2 @@",
      "+pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
      "+pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
      "",
    ].join("\n");
    const fAlphaOnly = await collectAstDeterministicFindings(dir, parseUnifiedDiff(diffOnlyAlpha));
    const panicAlphaOnly = fAlphaOnly.find((f) => f.type === "Bug");

    await writeFile(
      join(dir, "src", "lib.rs"),
      [
        "pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
        "pub fn beta(b: Option<i32>) -> i32 { b.unwrap() }",
        "pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
        "",
      ].join("\n"),
    );

    const diff1 = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -0,0 +1,3 @@",
      "+pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
      "+pub fn beta(b: Option<i32>) -> i32 { b.unwrap() }",
      "+pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
      "",
    ].join("\n");

    const f1 = await collectAstDeterministicFindings(dir, parseUnifiedDiff(diff1));
    const panics = f1.filter((f) => f.type === "Bug");
    // Multiple panics in the same file collapse into 1 per-file finding listing both functions
    expect(panics.length).toBe(1);
    expect(panics[0]?.title).toContain("`alpha`, `beta`");
    // Adding beta's .unwrap() MUST change the per-file finding's rootCause/fingerprint
    expect(panics[0]?.rootCause).not.toBe(panicAlphaOnly?.rootCause);

    const unsafe1 = f1.find((f) => f.type === "Soundness");
    expect(unsafe1).toBeDefined();

    // Shift gamma down by 2 blank lines -> unsafe fingerprint / rootCause MUST remain identical
    await writeFile(
      join(dir, "src", "lib.rs"),
      [
        "// line 1",
        "// line 2",
        "pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
        "pub fn beta(b: Option<i32>) -> i32 { b.unwrap() }",
        "pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
        "",
      ].join("\n"),
    );
    const diff2 = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -0,0 +1,5 @@",
      "+// line 1",
      "+// line 2",
      "+pub fn alpha(a: Option<i32>) -> i32 { a.unwrap() }",
      "+pub fn beta(b: Option<i32>) -> i32 { b.unwrap() }",
      "+pub fn gamma(p: *const i32) -> i32 { unsafe { *p } }",
      "",
    ].join("\n");
    const f2 = await collectAstDeterministicFindings(dir, parseUnifiedDiff(diff2));
    const unsafe2 = f2.find((f) => f.type === "Soundness");
    expect(unsafe2?.rootCause).toBe(unsafe1?.rootCause);
    expect(unsafe2?.id).toBe(unsafe1?.id);
  });

  test("Tier 1: inline // peer:allow(panic|unsafe): reason suppresses detectors and [detectors] off disables them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-allow-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "lib.rs"),
      [
        "pub fn suppressed(a: Option<i32>, p: *const i32) -> i32 {",
        "    // peer:allow(panic): invariant guaranteed by caller",
        "    let x = a.unwrap();",
        "    // peer:allow(unsafe): pointer validated above",
        "    unsafe { *p + x }",
        "}",
        "pub fn unsuppressed(b: Option<i32>) -> i32 {",
        "    // peer:allow(panic):",
        "    b.unwrap()",
        "}",
        "",
      ].join("\n"),
    );

    const diff = [
      "diff --git a/src/lib.rs b/src/lib.rs",
      "--- a/src/lib.rs",
      "+++ b/src/lib.rs",
      "@@ -0,0 +1,10 @@",
      "+pub fn suppressed(a: Option<i32>, p: *const i32) -> i32 {",
      "+    // peer:allow(panic): invariant guaranteed by caller",
      "+    let x = a.unwrap();",
      "+    // peer:allow(unsafe): pointer validated above",
      "+    unsafe { *p + x }",
      "+}",
      "+pub fn unsuppressed(b: Option<i32>) -> i32 {",
      "+    // peer:allow(panic):",
      "+    b.unwrap()",
      "+}",
      "",
    ].join("\n");

    const diffMap = parseUnifiedDiff(diff);
    const findings = await collectAstDeterministicFindings(dir, diffMap);
    // Suppressed panic & unsafe are skipped; reason-less `// peer:allow(panic):` is still flagged
    expect(findings.length).toBe(1);
    expect(findings[0]?.startLine).toBe(9);

    // Disabling panic detector returns 0 findings
    const disabled = await collectAstDeterministicFindings(dir, diffMap, { panic: "off" });
    expect(disabled.length).toBe(0);
  });

  test("collectAstDeterministicFindings skips .expect() calls preceded by /// # Panics or // Why: rationale comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-invariant-expect-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "state.rs"),
      [
        "/// Returns the primary spec.",
        "/// # Panics",
        "/// Panics only if constructed without legs (impossible via OrderRecord::new).",
        "pub fn primary_spec(legs: &[i32]) -> i32 {",
        '    *legs.first().expect("OrderRecord always has at least one leg")',
        "}",
        "pub fn why_commented(v: Option<i32>) -> i32 {",
        "    // Why: validated non-empty by preflight check above",
        '    v.expect("guaranteed by preflight")',
        "}",
        "pub fn unguarded(v: Option<i32>) -> i32 {",
        '    v.expect("unexplained expect")',
        "}",
        "",
      ].join("\n"),
    );

    const diff = [
      "diff --git a/src/state.rs b/src/state.rs",
      "--- a/src/state.rs",
      "+++ b/src/state.rs",
      "@@ -0,0 +1,13 @@",
      "+/// Returns the primary spec.",
      "+/// # Panics",
      "+/// Panics only if constructed without legs (impossible via OrderRecord::new).",
      "+pub fn primary_spec(legs: &[i32]) -> i32 {",
      '+    *legs.first().expect("OrderRecord always has at least one leg")',
      "+}",
      "+pub fn why_commented(v: Option<i32>) -> i32 {",
      "+    // Why: validated non-empty by preflight check above",
      '+    v.expect("guaranteed by preflight")',
      "+}",
      "+pub fn unguarded(v: Option<i32>) -> i32 {",
      '+    v.expect("unexplained expect")',
      "+}",
      "",
    ].join("\n");

    const findings = await collectAstDeterministicFindings(dir, parseUnifiedDiff(diff));
    expect(findings.length).toBe(1);
    expect(findings[0]?.startLine).toBe(12);
  });
});
