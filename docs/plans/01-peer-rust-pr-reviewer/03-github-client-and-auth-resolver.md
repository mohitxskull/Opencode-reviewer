# Task 03 — GitHub Client and Auth Resolver (`@octokit/rest`)

## Goal

Implement the GitHub authentication token resolver (`PEER_GITHUB_TOKEN` $\rightarrow$ `GITHUB_TOKEN` $\rightarrow$ `gh auth token` subprocess fallback), PR target identifier parser (`42`, `#42`, full GitHub PR URL), and the `@octokit/rest`-based `GitHubClient` for listing open PRs, fetching PR metadata and unified diffs, idempotently creating/updating the consolidated top-level Walkthrough comment, and creating `PENDING` (draft) or `COMMENT` GitHub PR Reviews with line-anchored inline threads.

## Files touched

- `src/github.ts` (implement)
- `tests/github.test.ts` (create)

## Deliverable

`src/github.ts` providing:
- `resolveGitHubToken(env?: Record<string, string | undefined>): Promise<string>` checking `PEER_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then running `gh auth token`, throwing `GitHubAuthError` with actionable remediation if none succeed.
- `parsePrTarget(target: string, defaultOwner: string, defaultRepo: string): { owner: string; repo: string; prNumber: number }` parsing `42`, `#42`, or `https://github.com/<owner>/<repo>/pull/<num>` (including trailing `/files` or `/commits` path segments).
- `GitHubClient` wrapping `Octokit` from `@octokit/rest` (accepting an optional custom `fetch` implementation in its constructor options for deterministic testing) and implementing:
  - `listOpenPrs(owner: string, repo: string, limit?: number): Promise<PullRequestSummary[]>` via `octokit.rest.pulls.list({ owner, repo, state: "open", per_page: limit })`
  - `getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestMetadata>` via `octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })`
  - `getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string>` via `octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber, mediaType: { format: "diff" } })`
  - `upsertWalkthroughComment(owner: string, repo: string, pullNumber: number, body: string): Promise<number>` (paginates `octokit.rest.issues.listComments`, finds any existing comment containing `<!-- peer-walkthrough-comment -->`, updates it in place via `octokit.rest.issues.updateComment`, or creates a new comment via `octokit.rest.issues.createComment`)
  - `postPrReview(options: PostPrReviewOptions): Promise<number>` (queries `octokit.rest.users.getAuthenticated()` and `octokit.rest.pulls.listReviews({ owner, repo, pull_number })`, deletes any pre-existing `PENDING` review owned by the authenticated user via `octokit.rest.pulls.deletePendingReview` so GitHub does not reject with `422 Unprocessable Entity`, then calls `octokit.rest.pulls.createReview` with `event` omitted when `submit === false` so it lands as a safe `PENDING` draft review, or `event: "COMMENT"` when `submit === true`).

## Constraints honoured

- [`rules/30-git.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/30-git.md) — Never hardcode or log tokens; never reply to or resolve third-party PR review threads.
- [`rules/70-code-rationale.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/70-code-rationale.md) — Document why `postPrReview` omits the `event` parameter by default (`PENDING` draft state) and why any pre-existing `PENDING` review by the current user is deleted first.
- [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — Out-of-process GitHub HTTP calls are tested by passing a deterministic mock `fetch` transport to `new Octokit({ auth, request: { fetch: mockFetch } })`, exercising the real `@octokit/rest` endpoint methods and request serialization.

## Named tests (bodies omitted)

- `tests/github.test.ts::"resolveGitHubToken follows env precedence and gh auth token fallback"` — Asserts that `PEER_GITHUB_TOKEN` wins over `GITHUB_TOKEN`, `GITHUB_TOKEN` wins when `PEER_GITHUB_TOKEN` is unset, `gh auth token` is used when both env vars are absent, and `GitHubAuthError` is thrown when all three fail.
- `tests/github.test.ts::"parsePrTarget accepts plain numbers, hash-prefixed numbers, and full GitHub URLs"` — Asserts parsing of `"42"`, `"#42"`, `"https://github.com/pingcap/tikv/pull/123"`, and `"https://github.com/pingcap/tikv/pull/123/files"` into `{ owner, repo, prNumber }`, and throws on malformed inputs.
- `tests/github.test.ts::"upsertWalkthroughComment updates existing marker comment instead of duplicating"` — Using a real `Octokit` instance backed by a recording `fetch` handler, asserts that when an existing issue comment contains `<!-- peer-walkthrough-comment -->`, `upsertWalkthroughComment` sends `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` rather than `POST`.
- `tests/github.test.ts::"postPrReview defaults to PENDING draft and deletes stale PENDING review first"` — Using a real `Octokit` instance backed by a recording `fetch` handler, asserts that `postPrReview({ ..., submit: false })` deletes an existing `PENDING` review belonging to the authenticated user, then sends `POST /repos/{owner}/{repo}/pulls/{num}/reviews` with `"event"` omitted from the JSON body and properly formatted single-line (`line`, `side: "RIGHT"`) and multi-line (`start_line`, `line`, `start_side: "RIGHT"`, `side: "RIGHT"`) inline comments.
- `tests/github.test.ts::"postPrReview with submit true sends event COMMENT"` — Asserts that `postPrReview({ ..., submit: true })` includes `"event": "COMMENT"` in the `octokit.rest.pulls.createReview` request payload.

## Code-only decisions

```ts
// Why: On GitHub REST API v3, omitting the `event` parameter in
// `octokit.rest.pulls.createReview` creates a PENDING (draft) review visible
// only to the authenticated developer until they review and submit it in the
// GitHub UI (or pass --submit-review). Because GitHub allows only one PENDING
// review per user per PR (returning HTTP 422 on a second POST), we delete any
// prior PENDING review owned by the same user before creating a fresh one.
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests` and `tsc --noEmit` pass with zero warnings.
- `bun test` runs all tests including `tests/github.test.ts` with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(github): add token resolver, PR target parser, and Octokit GitHub client
```

## Done-when

- [ ] `resolveGitHubToken` enforces `PEER_GITHUB_TOKEN` $\rightarrow$ `GITHUB_TOKEN` $\rightarrow$ `gh auth token`.
- [ ] `parsePrTarget` parses plain numbers, `#`-prefixed numbers, and full GitHub PR URLs.
- [ ] `GitHubClient.upsertWalkthroughComment` idempotently updates existing `<!-- peer-walkthrough-comment -->` comments via `@octokit/rest`.
- [ ] `GitHubClient.postPrReview` deletes stale `PENDING` reviews and defaults to `PENDING` draft mode (`event` omitted) unless `submit: true`.
- [ ] All 5 tests in `tests/github.test.ts` pass via `make check`.
