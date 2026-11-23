import { describe, expect, test } from "bun:test";

import {
  buildReviewContextPrompt,
  buildWalkthroughContextPrompt,
  type ReviewContext,
} from "../src/llm/context.ts";

const SAMPLE_CONTEXT: ReviewContext = {
  repoRoot: "/tmp/fake-rust-repo",
  pr: {
    owner: "tikv",
    repo: "tikv",
    number: 42,
    title: "raftstore: avoid lock held across await",
    body: "Fixes deadlock in raftstore peer fsm.",
    author: "alice",
    headRefName: "fix-await-lock",
    baseRefName: "master",
    headSha: "11111112222222",
    baseSha: "00000001111111",
    htmlUrl: "https://github.com/tikv/tikv/pull/42",
    updatedAt: "2026-11-22T00:00:00Z",
  },
  diffBaseSha: "00000001111111",
  headSha: "11111112222222",
  isIncremental: false,
  crateGraph: {
    crates: {
      raftstore: {
        name: "raftstore",
        manifestDir: "components/raftstore",
        layer: 0,
        dependencies: [],
      },
    },
    testLayer: 1,
  },
  diffMap: {
    "components/raftstore/src/lib.rs": {
      filePath: "components/raftstore/src/lib.rs",
      hunks: [
        {
          oldStart: 10,
          oldCount: 2,
          newStart: 10,
          newEnd: 12,
          header: "@@ -10,2 +10,3 @@",
          annotatedLines: [
            "L0010 ( ): pub async fn step() {",
            "L0011 (+):     let guard = mutex.lock().unwrap();",
            "L0012 ( ): }",
          ],
          rightSideLines: [10, 11, 12],
        },
      ],
    },
    "components/raftstore/tests/integration_test.rs": {
      filePath: "components/raftstore/tests/integration_test.rs",
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newEnd: 2,
          header: "@@ -1,1 +1,2 @@",
          annotatedLines: ["L0001 (+): #[test]", "L0002 (+): fn smoke() {}"],
          rightSideLines: [1, 2],
        },
      ],
    },
  },
  clippyDiagnostics: [],
};

describe("Review context prompt builders", () => {
  test("buildReviewContextPrompt puts high-risk prod files in Tier 1 and test files in Tier 2", () => {
    const prompt = buildReviewContextPrompt(SAMPLE_CONTEXT);
    expect(prompt).toContain("Tier 1: Primary High-Risk Rust Diff Hunks");
    expect(prompt).toContain("components/raftstore/src/lib.rs");
    expect(prompt).toContain("Tier 2: Secondary & Test Files");
    expect(prompt).toContain("components/raftstore/tests/integration_test.rs");
  });

  test("buildWalkthroughContextPrompt includes crate layers and PR metadata", () => {
    const prompt = buildWalkthroughContextPrompt(SAMPLE_CONTEXT);
    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("Layer 0 | crate: raftstore");
  });
});
