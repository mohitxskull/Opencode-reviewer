# Task 02 — Git Session and Checkpoint Store

## Goal

Implement local git repository discovery, GitHub `owner/repo` extraction from git remotes, the strict clean-working-tree gate, the signal-safe `InPlaceCheckoutSession` that checks out a PR head commit in place and guarantees restoration of the original symbolic branch or detached commit SHA, and the `.git/peer/reviews/pr-<number>/` incremental checkpoint and artifact store in `src/git.ts`.

## Files touched

- `src/git.ts` (implement)
- `tests/git.test.ts` (create)

## Deliverable

`src/git.ts` providing:
- `parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string }` supporting SSH (`git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`), HTTPS (`https://github.com/owner/repo.git`), and trailing slashes.
- `ensureCleanWorkingTree(repoRoot: string): Promise<void>` running `git status --porcelain --untracked-files=normal` and throwing `DirtyWorkingTreeError` listing offending paths if the working tree or index is not clean.
- `withInPlaceCheckout<T>(options: CheckoutOptions, fn: () => Promise<T>): Promise<T>` (and class `InPlaceCheckoutSession`) that records the original ref (`git symbolic-ref --short -q HEAD` if on a branch, or `git rev-parse --verify HEAD` if detached), registers temporary `SIGINT` and `SIGTERM` process listeners before fetching/checking out the target PR head SHA (`git fetch <remote> pull/<prNumber>/head` and `git checkout --detach <headSha>`), and synchronously restores the exact original branch or SHA (`git checkout -f <originalRef>`) in `finally` and inside the signal handler before exiting/re-throwing.
- `CheckpointStore` reading and writing `.git/peer/reviews/pr-<number>/checkpoint.json`, resolving whether an incremental delta (`lastReviewedHeadSha..currentHeadSha`) can be used (when `fresh === false`, a checkpoint exists, `baseSha` matches, and `lastReviewedHeadSha` is an ancestor of `currentHeadSha` via `git merge-base --is-ancestor`), and falling back to full `baseSha..currentHeadSha` review when `fresh === true` or the PR branch was force-pushed/rebased.

## Constraints honoured

- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) & [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — Integration tests in `tests/git.test.ts` create real temporary `git init` repositories on disk with real commits and branches (never mocking git subprocesses for repository state transitions).
- [`rules/70-code-rationale.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/70-code-rationale.md) — Document why `InPlaceCheckoutSession` checks out in-place with detached HEAD rather than creating a `git worktree`, and why `.git/peer/` is used instead of a workspace dot-folder.
- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.2) — Incremental commit-by-commit checkpoint tracking with automatic fallback on force-push/rebase and `--fresh` override.

## Named tests (bodies omitted)

- `tests/git.test.ts::"parseGitHubOwnerRepo supports SSH and HTTPS remotes"` — Asserts exact `{ owner, repo }` extraction across `git@github.com:tikv/tikv.git`, `https://github.com/tikv/tikv.git`, `https://github.com/tikv/tikv/`, and `ssh://git@github.com/tikv/tikv.git`, and throws `GitRemoteError` for non-GitHub URLs.
- `tests/git.test.ts::"ensureCleanWorkingTree rejects staged, unstaged, and untracked files while ignoring .git/peer"` — Against a real temporary git repo, asserts `ensureCleanWorkingTree` passes on a clean tree, throws `DirtyWorkingTreeError` when a tracked file is modified, staged, or an untracked working-tree file exists, while ignoring files written under `.git/peer/`.
- `tests/git.test.ts::"withInPlaceCheckout restores named branch on normal completion and thrown error"` — Against a real temporary git repo with branch `main` and a second commit `prHeadSha`, asserts that inside the callback `HEAD` is detached at `prHeadSha`, and after both normal return and an injected `Error`, symbolic ref `HEAD` is restored back to `main`.
- `tests/git.test.ts::"InPlaceCheckoutSession restores detached HEAD when signal handler fires"` — Against a real temporary git repo starting at a detached commit `origSha`, invokes the session's signal restoration hook while checked out at `prHeadSha` and asserts that `HEAD` is restored to `origSha`.
- `tests/git.test.ts::"CheckpointStore resolves incremental range on fast-forward and falls back on force-push or fresh"` — Against a real temporary git repo, asserts that `checkpointStore.resolveDiffBase(...)` returns `lastReviewedHeadSha` when the new PR head fast-forwards from `lastReviewedHeadSha`, and falls back to `prBaseSha` when `fresh: true` or when `lastReviewedHeadSha` is not an ancestor of `currentHeadSha`.

## Code-only decisions

```ts
// Why: Storing checkpoints and reports under .git/peer/reviews/pr-<number>/ keeps
// review state inside git's administrative directory so in-place branch checkouts
// never collide with generated files and `git status --porcelain` stays clean
// without modifying the user's .gitignore.
export const PEER_GIT_REVIEWS_REL_PATH = ".git/peer/reviews";
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests` and `tsc --noEmit` pass with zero errors.
- `bun test` runs all tests in `tests/models.test.ts` and `tests/git.test.ts` with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(git): add clean-tree gate, signal-safe in-place checkout, and checkpoint store
```

## Done-when

- [ ] `ensureCleanWorkingTree` refuses any dirty working tree while ignoring `.git/peer/`.
- [ ] `InPlaceCheckoutSession` / `withInPlaceCheckout` restores symbolic branches and detached SHAs on normal exit, exception, and `SIGINT`/`SIGTERM`.
- [ ] `CheckpointStore` persists Zod-validated `ReviewCheckpoint` JSON under `.git/peer/reviews/pr-<num>/checkpoint.json` and detects fast-forward vs force-push/rebase via `git merge-base --is-ancestor`.
- [ ] All tests in `tests/git.test.ts` pass via `make check`.
