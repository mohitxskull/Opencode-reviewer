import { describe, expect, test } from "bun:test";
import { GitHubAuthError, GitHubClient, parsePrTarget, resolveGitHubToken } from "../src/github.ts";
import { WALKTHROUGH_MARKER } from "../src/models.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

function createMockFetch(
  handler: (req: RecordedRequest) => { status?: number; body: unknown; contentType?: string },
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown = null;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const recorded: RecordedRequest = { method, url, body: parsedBody };
    requests.push(recorded);

    const result = handler(recorded);
    const status = result.status ?? 200;
    const contentType = result.contentType ?? "application/json";
    const responseBody =
      contentType === "application/json" ? JSON.stringify(result.body) : String(result.body);

    return new Response(responseBody, {
      status,
      headers: { "content-type": contentType },
    });
  };

  return { fetch: mockFetch as typeof fetch, requests };
}

describe("Task 03: GitHub client and auth resolver", () => {
  test("resolveGitHubToken follows env precedence and gh auth token fallback", async () => {
    // 1. PEER_GITHUB_TOKEN wins over GITHUB_TOKEN
    const t1 = await resolveGitHubToken(
      { PEER_GITHUB_TOKEN: "peer-tok-123", GITHUB_TOKEN: "gh-tok-456" },
      async () => "cli-tok-789",
    );
    expect(t1).toBe("peer-tok-123");

    // 2. GITHUB_TOKEN wins when PEER_GITHUB_TOKEN is absent
    const t2 = await resolveGitHubToken({ GITHUB_TOKEN: "gh-tok-456" }, async () => "cli-tok-789");
    expect(t2).toBe("gh-tok-456");

    // 3. gh auth token fallback when env vars are absent
    const t3 = await resolveGitHubToken({}, async () => "cli-tok-789\n");
    expect(t3).toBe("cli-tok-789");

    // 4. Throws GitHubAuthError when all three fail
    await expect(
      resolveGitHubToken({}, async () => {
        throw new Error("gh not logged in");
      }),
    ).rejects.toThrow(GitHubAuthError);
  });

  test("parsePrTarget accepts plain numbers, hash-prefixed numbers, and full GitHub URLs", () => {
    expect(parsePrTarget("42", "tikv", "tikv")).toEqual({
      owner: "tikv",
      repo: "tikv",
      prNumber: 42,
    });
    expect(parsePrTarget("#42", "tikv", "tikv")).toEqual({
      owner: "tikv",
      repo: "tikv",
      prNumber: 42,
    });
    expect(parsePrTarget("https://github.com/pingcap/tikv/pull/123", "default", "repo")).toEqual({
      owner: "pingcap",
      repo: "tikv",
      prNumber: 123,
    });
    expect(
      parsePrTarget("https://github.com/pingcap/tikv/pull/123/files", "default", "repo"),
    ).toEqual({
      owner: "pingcap",
      repo: "tikv",
      prNumber: 123,
    });

    expect(() => parsePrTarget("not-a-pr", "tikv", "tikv")).toThrow();
    expect(() =>
      parsePrTarget("https://github.com/pingcap/tikv/issues/123", "tikv", "tikv"),
    ).toThrow();
  });

  test("upsertWalkthroughComment updates existing marker comment instead of duplicating", async () => {
    const { fetch, requests } = createMockFetch((req) => {
      if (req.method === "GET" && req.url.includes("/issues/42/comments")) {
        return {
          body: [
            {
              id: 1001,
              body: "Some human comment",
            },
            {
              id: 2002,
              body: `${WALKTHROUGH_MARKER}\n## Old Walkthrough`,
            },
          ],
        };
      }
      if (req.method === "PATCH" && req.url.endsWith("/issues/comments/2002")) {
        return { body: { id: 2002 } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    });

    const client = new GitHubClient({ token: "test-token", fetch });
    const commentId = await client.upsertWalkthroughComment(
      "tikv",
      "tikv",
      42,
      `${WALKTHROUGH_MARKER}\n## Updated Walkthrough`,
    );

    expect(commentId).toBe(2002);
    expect(
      requests.some((r) => r.method === "PATCH" && r.url.endsWith("/issues/comments/2002")),
    ).toBe(true);
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  test("postPrReview defaults to PENDING draft and deletes stale PENDING review first", async () => {
    const { fetch, requests } = createMockFetch((req) => {
      if (req.method === "GET" && req.url.endsWith("/user")) {
        return { body: { login: "skull-reviewer", id: 77 } };
      }
      if (req.method === "GET" && req.url.includes("/pulls/42/reviews")) {
        return {
          body: [
            { id: 501, state: "COMMENTED", user: { login: "other-user" } },
            { id: 502, state: "PENDING", user: { login: "skull-reviewer" } },
          ],
        };
      }
      if (req.method === "DELETE" && req.url.endsWith("/pulls/42/reviews/502")) {
        return { body: { id: 502 } };
      }
      if (req.method === "POST" && req.url.endsWith("/pulls/42/reviews")) {
        return { body: { id: 600, state: "PENDING" } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    });

    const client = new GitHubClient({ token: "test-token", fetch });
    const reviewId = await client.postPrReview({
      owner: "tikv",
      repo: "tikv",
      prNumber: 42,
      commitId: "abcdef1234567",
      submit: false,
      summaryBody: "Peer review summary",
      comments: [
        {
          path: "src/lib.rs",
          startLine: 10,
          endLine: 10,
          body: "Single line finding",
        },
        {
          path: "src/engine.rs",
          startLine: 20,
          endLine: 25,
          body: "Multi-line finding",
        },
      ],
    });

    expect(reviewId).toBe(600);
    expect(
      requests.some((r) => r.method === "DELETE" && r.url.endsWith("/pulls/42/reviews/502")),
    ).toBe(true);

    const postReq = requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/pulls/42/reviews"),
    );
    expect(postReq).toBeDefined();
    const postBody = postReq?.body as Record<string, unknown>;
    // Omitting "event" tells GitHub to create a PENDING draft review
    expect("event" in postBody).toBe(false);
    expect(postBody.commit_id).toBe("abcdef1234567");
    expect(postBody.comments).toEqual([
      {
        path: "src/lib.rs",
        line: 10,
        side: "RIGHT",
        body: "Single line finding",
      },
      {
        path: "src/engine.rs",
        start_line: 20,
        start_side: "RIGHT",
        line: 25,
        side: "RIGHT",
        body: "Multi-line finding",
      },
    ]);
  });

  test("postPrReview with submit true sends event COMMENT", async () => {
    const { fetch, requests } = createMockFetch((req) => {
      if (req.method === "GET" && req.url.endsWith("/user")) {
        return { body: { login: "skull-reviewer", id: 77 } };
      }
      if (req.method === "GET" && req.url.includes("/pulls/42/reviews")) {
        return { body: [] };
      }
      if (req.method === "POST" && req.url.endsWith("/pulls/42/reviews")) {
        return { body: { id: 601, state: "COMMENTED" } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    });

    const client = new GitHubClient({ token: "test-token", fetch });
    const reviewId = await client.postPrReview({
      owner: "tikv",
      repo: "tikv",
      prNumber: 42,
      commitId: "abcdef1234567",
      submit: true,
      summaryBody: "Submitted review",
      comments: [],
    });

    expect(reviewId).toBe(601);
    const postReq = requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/pulls/42/reviews"),
    );
    const postBody = postReq?.body as Record<string, unknown>;
    expect(postBody.event).toBe("COMMENT");
  });
});
