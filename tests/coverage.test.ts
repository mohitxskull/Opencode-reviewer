import { describe, expect, test } from "bun:test";

import {
  CargoLlvmCovMissingError,
  collectCargoLlvmCovReport,
  coverageReportToFindings,
  formatCoveragePromptSection,
  groupContiguousLines,
} from "../src/analyzers/coverage.ts";
import type { DiffFileMap } from "../src/domain/models.ts";

const SAMPLE_DIFF_MAP: Record<string, DiffFileMap> = {
  "src/engine.rs": {
    filePath: "src/engine.rs",
    hunks: [
      {
        oldStart: 10,
        oldCount: 5,
        newStart: 10,
        newEnd: 16,
        header: "@@ -10,5 +10,7 @@",
        annotatedLines: [],
        rightSideLines: [10, 11, 12, 13, 14, 15, 16],
      },
    ],
  },
  "tests/integration.rs": {
    filePath: "tests/integration.rs",
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newEnd: 5,
        header: "@@ -1,1 +1,5 @@",
        annotatedLines: [],
        rightSideLines: [1, 2, 3, 4, 5],
      },
    ],
  },
};

const SAMPLE_LLVM_COV_JSON = JSON.stringify({
  data: [
    {
      files: [
        {
          filename: "/repo/src/engine.rs",
          segments: [
            [10, 1, 5, true, true],
            [11, 1, 5, true, true],
            [12, 1, 0, true, true],
            [13, 1, 0, true, true],
            [14, 1, 3, true, true],
            [15, 1, 0, true, true],
            [25, 1, 0, true, true], // Outside diff hunk -> ignored
          ],
        },
        {
          filename: "/repo/tests/integration.rs",
          segments: [[2, 1, 0, true, true]], // Test file -> ignored
        },
      ],
    },
  ],
});

describe("cargo-llvm-cov integration", () => {
  test("groups contiguous uncovered lines and intersects with diffMap while skipping test files", async () => {
    expect(groupContiguousLines([12, 13, 15])).toEqual([
      { startLine: 12, endLine: 13 },
      { startLine: 15, endLine: 15 },
    ]);

    const report = await collectCargoLlvmCovReport("/repo", SAMPLE_DIFF_MAP, {
      enabled: true,
      packages: ["engine"],
      runner: async () => ({
        stdout: SAMPLE_LLVM_COV_JSON,
        stderr: "",
        exitCode: 0,
      }),
    });

    expect(report).not.toBeNull();
    if (!report) {
      throw new Error("Expected non-null coverage report");
    }
    expect(report.files.length).toBe(1);
    expect(report.totalChangedExecutableLines).toBe(6);
    expect(report.totalUncoveredChangedLines).toBe(3);
    expect(report.files[0]?.uncoveredLines).toEqual([12, 13, 15]);
    expect(report.files[0]?.lineCoveragePercent).toBe(50);

    const prompt = formatCoveragePromptSection(report);
    expect(prompt).toContain("src/engine.rs");
    expect(prompt).toContain("12-13, 15");

    const findings = coverageReportToFindings(report);
    expect(findings.length).toBe(2);
    expect(findings[0]?.startLine).toBe(12);
    expect(findings[0]?.endLine).toBe(13);
    expect(findings[1]?.startLine).toBe(15);
    expect(findings[1]?.source).toBe("audit");
  });

  test("returns null when disabled and throws CargoLlvmCovMissingError when missing", async () => {
    const skipped = await collectCargoLlvmCovReport("/repo", SAMPLE_DIFF_MAP, {
      enabled: false,
    });
    expect(skipped).toBeNull();

    await expect(
      collectCargoLlvmCovReport("/repo", SAMPLE_DIFF_MAP, {
        enabled: true,
        runner: async () => ({
          stdout: "",
          stderr: "error: no such command: `llvm-cov`",
          exitCode: 101,
        }),
      }),
    ).rejects.toThrow(CargoLlvmCovMissingError);
  });
});
