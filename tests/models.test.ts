import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import {
  allowsFindingForProfile,
  type DiffFileMap,
  FindingSchema,
  isValidInlineRange,
  TriageScoreSchema,
} from "../src/models.ts";

describe("Task 01: Domain models and profile/hunk rules", () => {
  test("FindingSchema rejects inverted or non-positive line ranges", () => {
    expect(() =>
      FindingSchema.parse({
        id: "f-1",
        filePath: "src/lib.rs",
        startLine: 15,
        endLine: 10,
        severity: "Major",
        type: "Bug",
        title: "Inverted range",
        body: "Start line exceeds end line.",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Fix range.",
        confidence: 0.9,
        source: "soundness",
      }),
    ).toThrow(ZodError);

    expect(() =>
      FindingSchema.parse({
        id: "f-2",
        filePath: "src/lib.rs",
        startLine: 0,
        endLine: 5,
        severity: "Major",
        type: "Bug",
        title: "Zero start line",
        body: "Lines are 1-indexed.",
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: "Fix line index.",
        confidence: 0.9,
        source: "soundness",
      }),
    ).toThrow(ZodError);
  });

  test("allowsFindingForProfile with quiet allows only Critical and Major", () => {
    const base = {
      id: "f-1",
      filePath: "src/lib.rs",
      startLine: 10,
      endLine: 12,
      type: "Bug" as const,
      title: "Issue",
      body: "Details",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Fix it",
      confidence: 0.99,
      source: "idioms" as const,
    };

    expect(allowsFindingForProfile("quiet", { ...base, severity: "Critical" })).toBe(true);
    expect(allowsFindingForProfile("quiet", { ...base, severity: "Major" })).toBe(true);
    expect(allowsFindingForProfile("quiet", { ...base, severity: "Minor" })).toBe(false);
    expect(allowsFindingForProfile("quiet", { ...base, severity: "Trivial" })).toBe(false);
    expect(allowsFindingForProfile("quiet", { ...base, severity: "Info" })).toBe(false);
    expect(allowsFindingForProfile("quiet", { ...base, severity: "None" })).toBe(false);
  });

  test("allowsFindingForProfile with chill filters low-confidence Minor and all Trivial", () => {
    const base = {
      id: "f-1",
      filePath: "src/lib.rs",
      startLine: 10,
      endLine: 12,
      type: "Idioms" as const,
      title: "Issue",
      body: "Details",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Fix it",
      source: "idioms" as const,
    };

    expect(
      allowsFindingForProfile("chill", { ...base, severity: "Critical", confidence: 0.5 }),
    ).toBe(true);
    expect(allowsFindingForProfile("chill", { ...base, severity: "Major", confidence: 0.5 })).toBe(
      true,
    );
    expect(allowsFindingForProfile("chill", { ...base, severity: "Minor", confidence: 0.8 })).toBe(
      true,
    );
    expect(allowsFindingForProfile("chill", { ...base, severity: "Minor", confidence: 0.79 })).toBe(
      false,
    );
    expect(
      allowsFindingForProfile("chill", { ...base, severity: "Trivial", confidence: 1.0 }),
    ).toBe(false);
    expect(allowsFindingForProfile("chill", { ...base, severity: "Info", confidence: 1.0 })).toBe(
      false,
    );
    expect(allowsFindingForProfile("chill", { ...base, severity: "None", confidence: 1.0 })).toBe(
      false,
    );
  });

  test("allowsFindingForProfile with assertive allows all actionable severities", () => {
    const base = {
      id: "f-1",
      filePath: "src/lib.rs",
      startLine: 10,
      endLine: 12,
      type: "Refactor" as const,
      title: "Issue",
      body: "Details",
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: "Fix it",
      confidence: 0.5,
      source: "idioms" as const,
    };

    expect(allowsFindingForProfile("assertive", { ...base, severity: "Critical" })).toBe(true);
    expect(allowsFindingForProfile("assertive", { ...base, severity: "Major" })).toBe(true);
    expect(allowsFindingForProfile("assertive", { ...base, severity: "Minor" })).toBe(true);
    expect(allowsFindingForProfile("assertive", { ...base, severity: "Trivial" })).toBe(true);
    expect(allowsFindingForProfile("assertive", { ...base, severity: "Info" })).toBe(true);
    expect(allowsFindingForProfile("assertive", { ...base, severity: "None" })).toBe(false);
  });

  test("isValidInlineRange validates single-hunk containment", () => {
    const fileMap: DiffFileMap = {
      filePath: "src/engine.rs",
      hunks: [
        {
          oldStart: 10,
          oldCount: 5,
          newStart: 10,
          newEnd: 18,
          header: "@@ -10,5 +10,9 @@",
          annotatedLines: [],
          rightSideLines: [10, 11, 12, 13, 14, 15, 16, 17, 18],
        },
        {
          oldStart: 40,
          oldCount: 4,
          newStart: 45,
          newEnd: 50,
          header: "@@ -40,4 +45,6 @@",
          annotatedLines: [],
          rightSideLines: [45, 46, 47, 48, 49, 50],
        },
      ],
    };

    expect(isValidInlineRange(fileMap, 12, 16)).toBe(true);
    expect(isValidInlineRange(fileMap, 45, 50)).toBe(true);
    // Spans across two separate hunks -> invalid for GitHub inline comment API
    expect(isValidInlineRange(fileMap, 15, 46)).toBe(false);
    // Outside all hunks
    expect(isValidInlineRange(fileMap, 25, 30)).toBe(false);
    // Inverted range
    expect(isValidInlineRange(fileMap, 16, 12)).toBe(false);
  });

  test("TriageScoreSchema enforces reviewEffort in 1..5 and valid mergeRisk", () => {
    expect(
      TriageScoreSchema.parse({
        reviewEffort: 3,
        mergeRisk: "Medium",
        rationale: "Touches async lock paths across 2 crates.",
      }),
    ).toEqual({
      reviewEffort: 3,
      mergeRisk: "Medium",
      rationale: "Touches async lock paths across 2 crates.",
    });

    expect(() =>
      TriageScoreSchema.parse({
        reviewEffort: 0,
        mergeRisk: "Low",
        rationale: "Too low",
      }),
    ).toThrow(ZodError);

    expect(() =>
      TriageScoreSchema.parse({
        reviewEffort: 6,
        mergeRisk: "Low",
        rationale: "Too high",
      }),
    ).toThrow(ZodError);

    expect(() =>
      TriageScoreSchema.parse({
        reviewEffort: 2,
        mergeRisk: "UnknownRisk",
        rationale: "Invalid risk",
      }),
    ).toThrow(ZodError);
  });
});
