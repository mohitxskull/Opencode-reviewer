import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenCodeMultiLensOrchestrator } from "../src/lenses.ts";
import {
  type OpenCodeClientLike,
  OpenCodeProviderQuotaError,
  parseModelSpec,
} from "../src/opencode/client.ts";
import {
  buildReadOnlySessionPermissions,
  evaluatePermissionRule,
  READONLY_SESSION_PERMISSIONS,
} from "../src/opencode/permissions.ts";
import {
  buildReviewContextPrompt,
  buildWalkthroughContextPrompt,
  type ReviewContext,
} from "../src/prompts/context.ts";
import { extractJsonObject, LensOutputParseError } from "../src/prompts/parser.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

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

    // Secrets are denied even for read AND grep, except .env.example
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", ".env")).toBe("deny");
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "grep", ".env")).toBe("deny");
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "grep", "config/.env.local")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "grep", "certs/server.pem")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", "config/.env.local")).toBe(
      "deny",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "read", ".env.example")).toBe(
      "allow",
    );
    expect(evaluatePermissionRule(READONLY_SESSION_PERMISSIONS, "grep", ".env.example")).toBe(
      "allow",
    );

    // Scoped permissions deny host paths outside repoRoot (e.g. ~/.config/gh/hosts.yml, /proc/self/environ)
    const scoped = buildReadOnlySessionPermissions("/tmp/fake-rust-repo");
    expect(evaluatePermissionRule(scoped, "read", "/tmp/fake-rust-repo/src/lib.rs")).toBe("allow");
    expect(evaluatePermissionRule(scoped, "read", "src/lib.rs")).toBe("allow");
    expect(evaluatePermissionRule(scoped, "read", "/home/skull/.config/gh/hosts.yml")).toBe("deny");
    expect(evaluatePermissionRule(scoped, "read", "/proc/self/environ")).toBe("deny");
    expect(evaluatePermissionRule(scoped, "read", "/tmp/fake-rust-repo/.git/config")).toBe("deny");
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

    const repoRoot = await mkdtemp(join(tmpdir(), "peer-lenses-cache-"));
    tempDirs.push(repoRoot);
    const result = await orchestrator.runAllLenses({ ...SAMPLE_CONTEXT, repoRoot });

    expect(createdSessions.length).toBe(3);
    const expectedScopedPerms = buildReadOnlySessionPermissions(repoRoot);
    for (const s of createdSessions) {
      expect(s.permissions).toEqual(expectedScopedPerms);
    }
    expect(waitedSessions.length).toBe(3);
    expect(removedSessions.sort()).toEqual(["sess-1", "sess-2", "sess-3"]);

    expect(result.walkthrough.triage.reviewEffort).toBe(2);
    expect(result.walkthrough.changes.length).toBe(1);
    expect(result.findings.length).toBe(2);
    expect(result.findings.map((f) => f.source).sort()).toEqual(["idioms", "soundness"]);

    // Second run with identical context hits per-lens disk cache (0 additional OpenCode sessions created)
    const cachedResult = await orchestrator.runAllLenses({ ...SAMPLE_CONTEXT, repoRoot });
    expect(createdSessions.length).toBe(3);
    expect(cachedResult.findings.length).toBe(2);
  });

  test("buildReviewContextPrompt puts high-risk prod files in Tier 1 inline diff and secondary/test files in Tier 2 paths-only", () => {
    const contextWithTiers: ReviewContext = {
      ...SAMPLE_CONTEXT,
      learnings: [
        {
          id: "learn-1",
          rule: "Dual account snapshots are intentional.",
          scope: null,
          createdAt: "2026-11-22T00:00:00Z",
        },
      ],
      symbolGraph: {
        nodes: [
          {
            name: "clear_funding_sync",
            kind: "fn",
            filePath: "components/raftstore/src/lib.rs",
            line: 11,
            prodReferences: [],
            testReferences: [],
          },
        ],
      },
      diffMap: {
        ...SAMPLE_CONTEXT.diffMap,
        "tests/heavy_integration.rs": {
          filePath: "tests/heavy_integration.rs",
          hunks: [
            {
              oldStart: 1,
              oldCount: 2,
              newStart: 1,
              newEnd: 3,
              header: "@@ -1,2 +1,3 @@",
              annotatedLines: [
                "L0001 (+): #[test]",
                "L0002 (+): fn test_heavy_integration_flow() {",
                "L0003 (+):     assert_eq!(1, 1);",
              ],
              rightSideLines: [1, 2, 3],
            },
          ],
        },
      },
    };

    const prompt = buildReviewContextPrompt(contextWithTiers);

    // 1. Includes learnings and symbol graph
    expect(prompt).toContain("Dual account snapshots are intentional.");
    expect(prompt).toContain("0 production callers/refs outside definition");

    // 2. Production file (components/raftstore/src/lib.rs) is in Tier 1 with its annotated diff lines
    expect(prompt).toContain("### File: `components/raftstore/src/lib.rs`");
    expect(prompt).toContain("L0011 (+):     let guard = mutex.lock().unwrap();");

    // 3. Test file (tests/heavy_integration.rs) is in Tier 2 as path-only (its diff body is NOT dumped inline)
    expect(prompt).toContain(
      "## Tier 2: Secondary & Test Files (Paths Only — Request via `read` Tool Only If Needed)",
    );
    expect(prompt).toContain("- `tests/heavy_integration.rs`");
    expect(prompt).not.toContain("L0003 (+):     assert_eq!(1, 1);");
  });

  test("F-07: OpenCodeMultiLensOrchestrator retries walkthrough parse failure and records failedCohorts when a cohort fails all attempts", async () => {
    const diffMap: Record<string, (typeof SAMPLE_CONTEXT.diffMap)[string]> = {};
    for (let idx = 1; idx <= 8; idx++) {
      const path = `src/sub${idx}/mod.rs`;
      const sampleFile = SAMPLE_CONTEXT.diffMap["components/raftstore/src/lib.rs"];
      if (sampleFile) {
        diffMap[path] = { ...sampleFile, filePath: path };
      }
    }

    let walkthroughAttempts = 0;
    const promptsBySession = new Map<string, string>();
    let sessSeq = 0;

    const fakeClient: OpenCodeClientLike = {
      session: {
        create: async () => {
          sessSeq += 1;
          return { id: `s-${sessSeq}` };
        },
        prompt: async (input) => {
          promptsBySession.set(input.sessionID, input.text);
        },
        remove: async () => {},
      },
      experimental: {
        session: {
          wait: async () => {},
        },
      },
      message: {
        list: async (input) => {
          const text = promptsBySession.get(input.sessionID) ?? "";
          if (text.includes("LENS: WALKTHROUGH_ARCHITECTURE")) {
            walkthroughAttempts += 1;
            if (walkthroughAttempts === 1) {
              return {
                data: [{ type: "assistant", content: [{ type: "text", text: "not json" }] }],
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
                        summary: "Walkthrough succeeded on retry 2.",
                        changes: [],
                        sequenceDiagram: null,
                        triage: { reviewEffort: 2, mergeRisk: "Low", rationale: "ok" },
                      }),
                    },
                  ],
                },
              ],
            };
          }
          // Fail cohort-1 on both attempts, succeed on cohort-2
          if (text.includes("src/sub1/mod.rs")) {
            return { data: [{ type: "assistant", content: [{ type: "text", text: "bad json" }] }] };
          }
          return {
            data: [
              {
                type: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      findings: [],
                      consideredAndRejected: [],
                      deletionsProposed: [],
                      openQuestions: [],
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
      clientFactory: async () => fakeClient,
    });

    const repoRoot = await mkdtemp(join(tmpdir(), "peer-lenses-f07-"));
    tempDirs.push(repoRoot);
    const res = await orchestrator.runAllLenses({
      ...SAMPLE_CONTEXT,
      repoRoot,
      diffMap,
    });

    expect(walkthroughAttempts).toBe(2);
    expect(res.walkthrough.summary).toBe("Walkthrough succeeded on retry 2.");
    expect(res.failedCohorts?.length).toBe(1);
    expect(res.failedCohorts?.[0]).toContain("cohort-1");
  });

  test("OpenCodeMultiLensOrchestrator surfaces OpenCodeProviderQuotaError immediately on HTTP 429 provider.free-limit without futile retries", async () => {
    let promptCalls = 0;
    const fakeClient: OpenCodeClientLike = {
      session: {
        create: async () => ({ id: "quota-sess" }),
        prompt: async () => {
          promptCalls += 1;
        },
        remove: async () => {},
      },
      experimental: {
        session: {
          wait: async () => {},
        },
      },
      message: {
        list: async () => ({
          data: [
            {
              type: "assistant",
              finish: "error",
              error: {
                type: "provider.free-limit",
                message: "Free usage limit reached. Connect a provider or switch models.",
                status: 429,
                retryAfterMs: 33_000_000,
              },
              content: [],
            },
          ],
        }),
      },
    };

    const orchestrator = new OpenCodeMultiLensOrchestrator({
      clientFactory: async () => fakeClient,
    });

    const repoRoot = await mkdtemp(join(tmpdir(), "peer-lenses-quota-"));
    tempDirs.push(repoRoot);
    await expect(orchestrator.runAllLenses({ ...SAMPLE_CONTEXT, repoRoot })).rejects.toThrow(
      OpenCodeProviderQuotaError,
    );
    // In 3-lens mode, each of the 3 lenses fails on attempt 1 without retrying a 2nd time
    expect(promptCalls).toBe(3);
    expect(buildWalkthroughContextPrompt(SAMPLE_CONTEXT).length).toBeLessThan(
      buildReviewContextPrompt(SAMPLE_CONTEXT).length,
    );
  });
});
