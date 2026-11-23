import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectMiriReport,
  formatMiriPromptSection,
  MiriMissingError,
  miriReportToFindings,
  parseMiriOutput,
} from "../src/analyzers/miri.ts";
import type { DiffFileMap } from "../src/domain/models.ts";

const SAMPLE_MIRI_OUTPUT = `
running 1 test
test raw::tests::deref_uninit ... FAILED

failures:

---- raw::tests::deref_uninit stdout ----
error: Undefined Behavior: reading memory at alloc42[0x0..0x4], but memory is uninitialized until offset 4
  --> src/raw.rs:6:9
   |
 6 |         *ptr
   |         ^^^^ reading memory at alloc42[0x0..0x4]
   |
   = help: this indicates a bug in the program: it performed an invalid operation, and caused Undefined Behavior
`;

describe("miri integration", () => {
  test("parses Miri Undefined Behavior output into Critical Soundness findings", () => {
    const diags = parseMiriOutput(SAMPLE_MIRI_OUTPUT);
    expect(diags.length).toBe(1);
    expect(diags[0]?.kind).toBe("undefined_behavior");
    expect(diags[0]?.filePath).toBe("src/raw.rs");
    expect(diags[0]?.line).toBe(6);
    expect(diags[0]?.testName).toBe("raw::tests::deref_uninit");

    const findings = miriReportToFindings({
      modifiedUnsafeFiles: ["src/raw.rs"],
      testedCrates: [],
      skippedReason: null,
      diagnostics: diags,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("Critical");
    expect(findings[0]?.type).toBe("Soundness");
    expect(findings[0]?.source).toBe("audit");
  });

  test("uses Tree-sitter AST to run Miri only when diff touches unsafe regions and throws MiriMissingError when missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-miri-test-"));
    try {
      await Bun.write(
        join(dir, "src/safe.rs"),
        `pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n`,
      );
      await Bun.write(
        join(dir, "src/raw.rs"),
        `pub fn read_ptr(ptr: *const i32) -> i32 {\n    unsafe {\n        *ptr\n    }\n}\n`,
      );

      const safeDiff: Record<string, DiffFileMap> = {
        "src/safe.rs": {
          filePath: "src/safe.rs",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newEnd: 3,
              header: "@@ -1,1 +1,3 @@",
              annotatedLines: [],
              rightSideLines: [1, 2, 3],
            },
          ],
        },
      };

      let runnerCalled = false;
      const skippedReport = await collectMiriReport(dir, safeDiff, {
        enabled: true,
        runner: async () => {
          runnerCalled = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      });
      expect(runnerCalled).toBe(false);
      expect(skippedReport?.skippedReason).toContain("No modified unsafe regions");

      const unsafeDiff: Record<string, DiffFileMap> = {
        "src/raw.rs": {
          filePath: "src/raw.rs",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 2,
              newEnd: 4,
              header: "@@ -1,1 +2,3 @@",
              annotatedLines: [],
              rightSideLines: [2, 3, 4],
            },
          ],
        },
      };

      const ubReport = await collectMiriReport(dir, unsafeDiff, {
        enabled: true,
        runner: async () => ({
          stdout: SAMPLE_MIRI_OUTPUT,
          stderr: "",
          exitCode: 101,
        }),
      });
      expect(ubReport).not.toBeNull();
      if (!ubReport) {
        throw new Error("Expected non-null Miri report");
      }
      expect(ubReport.modifiedUnsafeFiles).toEqual(["src/raw.rs"]);
      expect(ubReport.diagnostics.length).toBe(1);
      expect(formatMiriPromptSection(ubReport)).toContain("CRITICAL UNDEFINED_BEHAVIOR");

      await expect(
        collectMiriReport(dir, unsafeDiff, {
          enabled: true,
          runner: async () => ({
            stdout: "",
            stderr: "error: toolchain 'nightly' is not installed",
            exitCode: 1,
          }),
        }),
      ).rejects.toThrow(MiriMissingError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
