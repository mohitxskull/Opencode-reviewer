import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRustSymbolGraph,
  extractModifiedRustSymbols,
  formatSymbolGraphSummary,
} from "../src/analyzers/symbol-graph.ts";
import { parseUnifiedDiff } from "../src/domain/diff.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Rust symbol and call-site code graph", () => {
  test("extractModifiedRustSymbols finds modified fn, struct, enum, and trait definitions from diff hunks", () => {
    const diff = `diff --git a/src/funding.rs b/src/funding.rs
--- a/src/funding.rs
+++ b/src/funding.rs
@@ -10,4 +10,12 @@ impl FundingState {
+    pub fn mark_funding_sync_required(&mut self) {
+        self.needs_sync = true;
+    }
+
+    pub fn clear_funding_sync(&mut self) {
+        self.needs_sync = false;
+    }
+}
+pub struct FundingLedger {
+    pub needs_sync: bool,
 }
`;
    const diffMap = parseUnifiedDiff(diff);
    const symbols = extractModifiedRustSymbols(diffMap);

    expect(symbols.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath }))).toEqual([
      { name: "mark_funding_sync_required", kind: "fn", filePath: "src/funding.rs" },
      { name: "clear_funding_sync", kind: "fn", filePath: "src/funding.rs" },
      { name: "FundingLedger", kind: "struct", filePath: "src/funding.rs" },
    ]);
    expect(symbols.every((s) => s.isPublic === true)).toBe(true);
  });

  test("buildRustSymbolGraph resolves cross-workspace production vs test callers and flags uncalled symbols", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-graph-test-"));
    tempDirs.push(repo);

    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: repo });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });

    await writeFile(
      join(repo, "src", "funding.rs"),
      [
        "pub struct FundingState { pub needs_sync: bool }",
        "impl FundingState {",
        "    pub fn mark_funding_sync_required(&mut self) {",
        "        self.needs_sync = true;",
        "    }",
        "    pub fn clear_funding_sync(&mut self) {",
        "        self.needs_sync = false;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(repo, "src", "reconcile.rs"),
      [
        "use crate::funding::FundingState;",
        "pub fn on_failure(state: &mut FundingState) {",
        "    state.mark_funding_sync_required();",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(repo, "tests", "funding_test.rs"),
      [
        "fn test_clear() {",
        "    // clear_funding_sync only referenced in tests, never in production src/",
        '    let _ = "clear_funding_sync";',
        "}",
        "",
      ].join("\n"),
    );

    Bun.spawnSync(["git", "add", "."], { cwd: repo });

    const diff = `diff --git a/src/funding.rs b/src/funding.rs
--- a/src/funding.rs
+++ b/src/funding.rs
@@ -2,7 +2,7 @@ impl FundingState {
+    pub fn mark_funding_sync_required(&mut self) {
+        self.needs_sync = true;
+    }
+    pub fn clear_funding_sync(&mut self) {
+        self.needs_sync = false;
+    }
 }
`;
    const diffMap = parseUnifiedDiff(diff);
    const graph = await buildRustSymbolGraph(repo, diffMap);

    const markNode = graph.nodes.find((n) => n.name === "mark_funding_sync_required");
    expect(markNode).toBeDefined();
    expect(markNode?.prodReferences.length).toBe(1);
    expect(markNode?.prodReferences[0]?.filePath).toBe("src/reconcile.rs");

    const clearNode = graph.nodes.find((n) => n.name === "clear_funding_sync");
    expect(clearNode).toBeDefined();
    expect(clearNode?.prodReferences.length).toBe(0);
    expect(clearNode?.testReferences.length).toBe(1);

    const summary = formatSymbolGraphSummary(graph);
    expect(summary).toContain("mark_funding_sync_required");
    expect(summary).toContain("src/reconcile.rs:3");
    expect(summary).toContain("clear_funding_sync");
    expect(summary).toContain("0 production callers/refs outside definition");
  });

  test("F-13: extractModifiedRustSymbols ignores commented-out fn declarations and keys symbols by filePath::name across files", () => {
    const diff = [
      "diff --git a/src/a.rs b/src/a.rs",
      "--- a/src/a.rs",
      "+++ b/src/a.rs",
      "@@ -1,1 +1,3 @@",
      " // header",
      "+// pub fn fake_commented_function() {}",
      "+pub fn validate_order() {}",
      "diff --git a/src/b.rs b/src/b.rs",
      "--- a/src/b.rs",
      "+++ b/src/b.rs",
      "@@ -1,1 +1,2 @@",
      " // header",
      "+pub fn validate_order() {}",
      "",
    ].join("\n");

    const diffMap = parseUnifiedDiff(diff);
    const symbols = extractModifiedRustSymbols(diffMap);
    expect(symbols.map((s) => `${s.filePath}::${s.name}`)).toEqual([
      "src/a.rs::validate_order",
      "src/b.rs::validate_order",
    ]);
  });

  test("buildRustSymbolGraph skips benchmark and test files when extracting modified production symbols", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-graph-bench-"));
    tempDirs.push(repo);
    Bun.spawnSync(["git", "init"], { cwd: repo });
    await mkdir(join(repo, "benches"), { recursive: true });
    await writeFile(join(repo, "benches", "hot_paths.rs"), "pub fn bench_hot_loop() {}\n");
    Bun.spawnSync(["git", "add", "."], { cwd: repo });

    const diff = [
      "diff --git a/benches/hot_paths.rs b/benches/hot_paths.rs",
      "--- a/benches/hot_paths.rs",
      "+++ b/benches/hot_paths.rs",
      "@@ -0,0 +1,1 @@",
      "+pub fn bench_hot_loop() {}",
      "",
    ].join("\n");
    const graph = await buildRustSymbolGraph(repo, parseUnifiedDiff(diff));
    expect(graph.nodes).toEqual([]);
  });
});
