import { describe, expect, test } from "bun:test";
import {
  clippyToFindings,
  deduplicateAndFilterFindings,
  partitionAndFilterFindings,
} from "../src/judge.ts";
import type { ClippyDiagnostic, DiffFileMap, Finding } from "../src/models.ts";

const SAMPLE_DIFF_MAP: Record<string, DiffFileMap> = {
  "src/lib.rs": {
    filePath: "src/lib.rs",
    hunks: [
      {
        oldStart: 10,
        oldCount: 5,
        newStart: 10,
        newEnd: 20,
        header: "@@ -10,5 +10,11 @@",
        annotatedLines: [],
        rightSideLines: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      },
    ],
  },
};

describe("Task 06: Judge deduplication and profile filtering", () => {
  test("deduplicateAndFilterFindings merges overlapping Clippy and lens findings keeping highest severity", () => {
    const clippyDiags: ClippyDiagnostic[] = [
      {
        filePath: "src/lib.rs",
        startLine: 12,
        endLine: 12,
        level: "warning",
        code: "clippy::needless_return",
        message: "unneeded `return` statement",
        rendered: "warning: unneeded `return` statement",
        suggestedReplacement: "    x + 1",
      },
    ];

    const clippyFindings = clippyToFindings(clippyDiags, SAMPLE_DIFF_MAP);
    expect(clippyFindings.length).toBe(1);

    const lensFinding: Finding = {
      id: "soundness-1",
      filePath: "src/lib.rs",
      startLine: 11,
      endLine: 13,
      severity: "Major",
      type: "Bug",
      title: "Unchecked arithmetic on line 12",
      body: "Use checked_add to avoid overflow.",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Replace x + 1 with checked_add.",
      confidence: 0.92,
      source: "soundness",
    };

    const merged = deduplicateAndFilterFindings(
      [...clippyFindings, lensFinding],
      SAMPLE_DIFF_MAP,
      "chill",
    );

    expect(merged.length).toBe(1);
    expect(merged[0]?.severity).toBe("Major");
    expect(merged[0]?.suggestion).toBe("    x + 1");
    expect(merged[0]?.agentPrompt).toContain("checked_add");
    expect(merged[0]?.agentPrompt).toContain("clippy::needless_return");
  });

  test("deduplicateAndFilterFindings drops findings outside diff hunks and applies profile gate", () => {
    const findings: Finding[] = [
      // Outside hunk (line 50 is far from 10..20) -> dropped
      {
        id: "f-outside",
        filePath: "src/lib.rs",
        startLine: 50,
        endLine: 52,
        severity: "Critical",
        type: "Bug",
        title: "Outside diff",
        body: "Far from hunk",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Fix",
        confidence: 0.99,
        source: "soundness",
      },
      // Slightly offset (line 8..12 is within 3 lines of hunk 10..20) -> snapped to 10..12
      {
        id: "f-snapped",
        filePath: "src/lib.rs",
        startLine: 8,
        endLine: 12,
        severity: "Critical",
        type: "Soundness",
        title: "Near boundary",
        body: "Snapped into hunk",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Fix boundary",
        confidence: 0.95,
        source: "soundness",
      },
      // Trivial finding inside hunk -> filtered out by "chill" and "quiet", allowed by "assertive"
      {
        id: "f-trivial",
        filePath: "src/lib.rs",
        startLine: 18,
        endLine: 18,
        severity: "Trivial",
        type: "Refactor",
        title: "Nitpick",
        body: "Rename local variable",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Rename",
        confidence: 0.9,
        source: "idioms",
      },
    ];

    const chillResult = deduplicateAndFilterFindings(findings, SAMPLE_DIFF_MAP, "chill");
    expect(chillResult.length).toBe(1);
    expect(chillResult[0]?.id).toBe("f-snapped");
    expect(chillResult[0]?.startLine).toBe(10);
    expect(chillResult[0]?.endLine).toBe(12);

    const assertiveResult = deduplicateAndFilterFindings(findings, SAMPLE_DIFF_MAP, "assertive");
    expect(assertiveResult.length).toBe(2);
    expect(assertiveResult.map((f) => f.id)).toEqual(["f-snapped", "f-trivial"]);
  });

  test("partitionAndFilterFindings separates inline findings, outside-diff-range findings, and nitpick findings", () => {
    const findings: Finding[] = [
      // 1. Inside diff hunk (10..20), Critical -> inlineFindings
      {
        id: "f-inline",
        filePath: "src/lib.rs",
        startLine: 12,
        endLine: 14,
        severity: "Critical",
        type: "Bug",
        title: "Inline bug",
        body: "Inside diff hunk",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Fix inline",
        confidence: 0.95,
        source: "soundness",
      },
      // 2. Outside diff hunk (line 50..52 on src/lib.rs, or another workspace file), Major -> outsideDiffFindings
      {
        id: "f-outside",
        filePath: "src/lib.rs",
        startLine: 50,
        endLine: 52,
        severity: "Major",
        type: "Soundness",
        title: "Uncalled reset method outside diff hunk",
        body: "clear_funding_sync at line 50 is never called",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Call clear_funding_sync",
        confidence: 0.92,
        source: "soundness",
      },
      // 3. Inside diff hunk (line 18), Trivial -> under "chill" goes to nitpickFindings instead of polluting inline comments
      {
        id: "f-nitpick",
        filePath: "src/lib.rs",
        startLine: 18,
        endLine: 18,
        severity: "Trivial",
        type: "Refactor",
        title: "Minor naming nitpick",
        body: "Use as_ prefix",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Rename helper",
        confidence: 0.9,
        source: "idioms",
      },
    ];

    const partitioned = partitionAndFilterFindings(findings, SAMPLE_DIFF_MAP, "chill");
    expect(partitioned.inlineFindings.map((f) => f.id)).toEqual(["f-inline"]);
    expect(partitioned.outsideDiffFindings.map((f) => f.id)).toEqual(["f-outside"]);
    expect(partitioned.nitpickFindings.map((f) => f.id)).toEqual(["f-nitpick"]);
  });
});
