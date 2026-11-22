import { describe, expect, test } from "bun:test";
import {
  evaluatePermissionRule,
  extractJsonObject,
  LensOutputParseError,
  type OpenCodeClientLike,
  OpenCodeMultiLensOrchestrator,
  parseModelSpec,
  READONLY_SESSION_PERMISSIONS,
  type ReviewContext,
} from "../src/lenses.ts";

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
  },
  clippyDiagnostics: [],
};

describe("Task 05: OpenCode multi-lens orchestrator", () => {
  test("parseModelSpec resolves default hy4-flash-free, bare opencode models, and provider/model pairs", () => {
    expect(parseModelSpec(undefined, {})).toEqual({
      providerID: "opencode",
      id: "hy4-flash-free",
    });
    expect(parseModelSpec("big-pickle", {})).toEqual({
      providerID: "opencode",
      id: "big-pickle",
    });
    expect(parseModelSpec(undefined, { MODEL: "big-pickle" })).toEqual({
      providerID: "opencode",
      id: "big-pickle",
    });
    expect(
      parseModelSpec(undefined, { PEER_MODEL: "opencode/hy4-flash-free", MODEL: "big-pickle" }),
    ).toEqual({
      providerID: "opencode",
      id: "hy4-flash-free",
    });
    expect(parseModelSpec("anthropic/claude-sonnet-4-5", {})).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    });
  });

  test("READONLY_SESSION_PERMISSIONS denies wildcard mutations and secrets while allowing read, grep, and glob", () => {
    // Under OpenCode's last-matching-rule-wins evaluator:
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "edit", "src/lib.rs")).toBe("deny");
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "write", "src/lib.rs")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "shell", "cargo clean")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "question", "*")).toBe("deny");

    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", "src/lib.rs")).toBe(
      "allow",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "grep", "src/lib.rs")).toBe(
      "allow",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "glob", "src/**/*.rs")).toBe(
      "allow",
    );

    // Secrets are denied even for read, except .env.example
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", ".env")).toBe("deny");
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", "config/.env.local")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", ".env.example")).toBe(
      "allow",
    );
  });

  test("extractJsonObject parses both raw JSON and markdown-fenced JSON responses", () => {
    const raw = `{"summary":"clean","changes":[],"sequenceDiagram":null,"triage":{"reviewEffort":1,"mergeRisk":"Low","rationale":"small"}}`;
    expect(extractJsonObject(raw)).toEqual({
      summary: "clean",
      changes: [],
      sequenceDiagram: null,
      triage: { reviewEffort: 1, mergeRisk: "Low", rationale: "small" },
    });

    const fenced = `Here is my review result:\n\`\`\`json\n{"findings": []}\n\`\`\`\nDone!`;
    expect(extractJsonObject(fenced)).toEqual({ findings: [] });

    expect(() => extractJsonObject("No JSON object here at all")).toThrow(LensOutputParseError);
  });

  test("OpenCodeMultiLensOrchestrator runs three lenses concurrently, validates Zod schemas, and removes sessions", async () => {
    const createdSessions: Array<{ id: string; title?: string; permissions: unknown }> = [];
    const promptedSessions: Array<{ sessionID: string; text: string }> = [];
    const waitedSessions: string[] = [];
    const removedSessions: string[] = [];

    let counter = 0;
    const fakeClient: OpenCodeClientLike = {
      session: {
        create: async (input) => {
          counter += 1;
          const id = `sess-${counter}`;
          createdSessions.push({
            id,
            title: input.title,
            permissions: input.permissions,
          });
          return { id };
        },
        prompt: async (input) => {
          promptedSessions.push(input);
        },
        remove: async (input) => {
          removedSessions.push(input.sessionID);
        },
      },
      experimental: {
        session: {
          wait: async (input) => {
            waitedSessions.push(input.sessionID);
          },
        },
      },
      message: {
        list: async (input) => {
          const promptEntry = promptedSessions.find((p) => p.sessionID === input.sessionID);
          const text = promptEntry?.text ?? "";
          if (text.includes("LENS: WALKTHROUGH_ARCHITECTURE")) {
            return {
              data: [
                {
                  type: "assistant",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        summary: "Fixes lock across await in raftstore.",
                        changes: [
                          {
                            layer: 0,
                            crateName: "raftstore",
                            filePath: "components/raftstore/src/lib.rs",
                            summary: "Scope mutex guard before async yield.",
                          },
                        ],
                        sequenceDiagram: "sequenceDiagram\n  Peer->>Mutex: lock()",
                        triage: {
                          reviewEffort: 2,
                          mergeRisk: "Medium",
                          rationale: "Concurrency fix in core raftstore.",
                        },
                      }),
                    },
                  ],
                },
              ],
            };
          }
          if (text.includes("LENS: SOUNDNESS_CONCURRENCY")) {
            return {
              data: [
                {
                  type: "assistant",
                  content: [
                    {
                      type: "text",
                      text: `\`\`\`json\n${JSON.stringify({
                        findings: [
                          {
                            filePath: "components/raftstore/src/lib.rs",
                            startLine: 11,
                            endLine: 11,
                            severity: "Critical",
                            type: "Concurrency",
                            title: "std::sync::Mutex guard held across await",
                            body: "Holding a synchronous mutex guard across await can deadlock worker threads.",
                            suggestion: "    let value = { *mutex.lock().unwrap() };",
                            agentPrompt:
                              "Drop the synchronous mutex guard before awaiting in step().",
                            confidence: 0.95,
                          },
                        ],
                      })}\n\`\`\``,
                    },
                  ],
                },
              ],
            };
          }
          return {
            data: [
              {
                type: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      findings: [
                        {
                          filePath: "components/raftstore/src/lib.rs",
                          startLine: 11,
                          endLine: 11,
                          severity: "Minor",
                          type: "Idioms",
                          title: "Avoid unwrap() in production raftstore path",
                          body: "Propagate poison error or use parking_lot::Mutex.",
                          suggestion: null,
                          agentPrompt: "Replace unwrap() with proper error handling.",
                          confidence: 0.85,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          };
        },
      },
    };

    const orchestrator = new OpenCodeMultiLensOrchestrator({
      model: { providerID: "opencode", id: "hy4-flash-free" },
      clientFactory: async () => fakeClient,
    });

    const result = await orchestrator.runAllLenses(SAMPLE_CONTEXT);

    expect(createdSessions.length).toBe(3);
    for (const s of createdSessions) {
      expect(s.permissions).toEqual(READONLY_SESSION_PERMISSIONS);
    }
    expect(waitedSessions.length).toBe(3);
    expect(removedSessions.sort()).toEqual(["sess-1", "sess-2", "sess-3"]);

    expect(result.walkthrough.triage.reviewEffort).toBe(2);
    expect(result.walkthrough.changes.length).toBe(1);
    expect(result.findings.length).toBe(2);
    expect(result.findings.map((f) => f.source).sort()).toEqual(["idioms", "soundness"]);
  });
});
