import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, snapRangeToHunk } from "../src/diff.ts";

const SAMPLE_DIFF = `diff --git a/src/lib.rs b/src/lib.rs
index 1111111..2222222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,4 +10,5 @@ pub fn demo() {
     let a = 1;
-    let b = 2;
+    let b = 20;
+    let c = 30;
     println!("{}", a + b);
 }
@@ -40,3 +41,4 @@ pub fn second() {
     let x = 10;
+    let y = 20;
     println!("{}", x);
 }
diff --git a/src/removed.rs b/src/removed.rs
deleted file mode 100644
index 3333333..0000000
--- a/src/removed.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-pub fn old() {}
-
`;

describe("Task 04: Unified diff line mapper", () => {
  test("parseUnifiedDiff maps right-side hunks and annotates explicit line numbers", () => {
    const map = parseUnifiedDiff(SAMPLE_DIFF);

    expect("src/removed.rs" in map).toBe(false);
    const libMap = map["src/lib.rs"];
    expect(libMap).toBeDefined();
    expect(libMap?.hunks.length).toBe(2);

    const hunk0 = libMap?.hunks[0];
    expect(hunk0?.newStart).toBe(10);
    expect(hunk0?.newEnd).toBe(14);
    expect(hunk0?.rightSideLines).toEqual([10, 11, 12, 13, 14]);
    expect(hunk0?.annotatedLines).toEqual([
      "L0010 ( ):     let a = 1;",
      "L0011 (+):     let b = 20;",
      "L0012 (+):     let c = 30;",
      'L0013 ( ):     println!("{}", a + b);',
      "L0014 ( ): }",
    ]);

    const hunk1 = libMap?.hunks[1];
    expect(hunk1?.newStart).toBe(41);
    expect(hunk1?.newEnd).toBe(44);
  });

  test("snapRangeToHunk preserves valid ranges, snaps near-boundary ranges, and rejects cross-hunk ranges", () => {
    const map = parseUnifiedDiff(SAMPLE_DIFF);
    const libMap = map["src/lib.rs"];
    if (!libMap) {
      throw new Error("Expected src/lib.rs in diff map");
    }

    // Valid in-hunk range preserved
    expect(snapRangeToHunk(libMap, 11, 13)).toEqual({ startLine: 11, endLine: 13 });

    // Near-boundary range (within 3 lines of hunk 10..14) snapped into 10..13
    expect(snapRangeToHunk(libMap, 8, 13, 3)).toEqual({ startLine: 10, endLine: 13 });

    // Cross-hunk range spanning 12..42 rejected
    expect(snapRangeToHunk(libMap, 12, 42, 3)).toBeNull();

    // Range far outside any hunk rejected
    expect(snapRangeToHunk(libMap, 25, 28, 3)).toBeNull();
  });
});
