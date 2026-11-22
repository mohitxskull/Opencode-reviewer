# Plan 01 — Peer Local Rust PR Reviewer (TypeScript + Bun + OpenCode SDK)

## Goal

Build **`peer`** — a local-first CLI tool written in **100% TypeScript on Bun (`1.4.0`)**, powered by **`@opencode/client` (`2.3.2`)** and **`@octokit/rest` (`22.0.1`)**, that runs directly inside a developer's local Rust git repository to review GitHub Pull Requests with real compiler/Clippy ground truth, parallel multi-lens agentic reasoning, CodeRabbit-grade walkthrough + surgical inline comment UX, and transactional `cargo check` verification of every proposed ```` ```suggestion ```` block before emitting local reports or posting to GitHub.

Why it matters: Cloud PR review sandboxes (including CodeRabbit's remote SaaS and thin collector CLI; see [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md)) cold-build Rust workspaces in ephemeral containers where `build.rs`, proc-macros, private registries, and large dependency graphs regularly time out or fall back to unverified text/AST review. By running in-place inside the developer's local repository with a warm `target/` cache, `peer` combines CodeRabbit's two-layer mental-model + inline-suggestion UX with deterministic `rustc`/`cargo clippy` diagnostics and compiler-verified suggestions.

### Deliverables

1. **Packaged TypeScript + Bun CLI (`peer`)** with exact dependency pins (`@opencode/client: "2.3.2"`, `@octokit/rest: "22.0.1"`, `zod: "4.6.7"`, `@biomejs/biome: "2.6.8"`, `typescript: "7.0.2"`, `@types/bun: "1.4.5"`) and a single whole-check command (`make check`) running `biome check`, `tsc --noEmit`, and `bun test`.
2. **In-Place Git Session & Incremental Checkpoint Store (`src/git.ts`)** enforcing a clean working tree before fetch/checkout, guaranteeing restoration of the original symbolic branch or detached HEAD SHA on normal exit, exception, or `SIGINT`/`SIGTERM`, and persisting checkpoints/artifacts under `.git/peer/reviews/pr-<number>/`.
3. **GitHub Auth & Octokit Client (`src/github.ts`)** resolving tokens via `PEER_GITHUB_TOKEN` $\rightarrow$ `GITHUB_TOKEN` $\rightarrow$ `gh auth token`, listing open PRs, fetching PR metadata and unified diffs via `@octokit/rest`, upserting the top-level Walkthrough comment idempotently, and creating `PENDING` (draft) GitHub PR Reviews by default with line-anchored inline comments.
4. **Rust Ground-Truth Collector & Unified Diff Mapper (`src/rust.ts`, `src/diff.ts`)** mapping unified diff hunks to valid GitHub right-side (`NEW`) line intervals, ordering modified files by `cargo metadata` crate-graph layer, and collecting structured `cargo clippy --workspace --all-targets --message-format=json` diagnostics.
5. **OpenCode SDK Multi-Lens Orchestrator (`src/lenses.ts`)** using `@opencode/client` (`OpenCode.make`) and `@opencode/client/service` (`Service.ensure`, `Service.headers`) to run three concurrent, strictly read-only OpenCode sessions (Walkthrough & Architecture; Soundness, `unsafe` & Async/Concurrency; Idioms, Performance & Logic) with default model `{ providerID: "opencode", id: process.env.MODEL ?? "hy4-flash-free" }`, read-only permission rules (`READONLY_SESSION_PERMISSIONS`), automatic session cleanup (`client.session.remove`), and Zod-validated structured JSON outputs.
6. **Judge & Transactional Suggestion Compiler Verifier (`src/judge.ts`, `src/verifier.ts`)** deduplicating Clippy + lens findings, enforcing diff-hunk line anchoring and profile severity gates (`quiet`, `chill`, `assertive`), and compile-checking every candidate single-hunk `suggestion` via `cargo check` inside a byte-restoring transactional wrapper.
7. **CodeRabbit-Grade Markdown & ANSI Terminal Renderers + CLI (`src/render/markdown.ts`, `src/render/terminal.ts`, `src/cli.ts`)** producing the top-level walkthrough (summary, architectural layer table, Mermaid `sequenceDiagram`, effort/risk triage score), inline comments (`_Type_ | _Severity_`, verified ```` ```suggestion ```` blocks, sanitized `<details><summary>Prompt for Coding Agents</summary>`), `.git/peer/reviews/pr-<number>/` artifacts, and the `peer` / `peer review` command.

## Current state

*Read before executing.*

- `/home/skull/Projects/peer` contains:
  - [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md)
  - [`docs/tmp/free-model.ts`](../../tmp/free-model.ts) — working reference script demonstrating `@opencode/client` (`2.3.2`) and `@opencode/client/service` on Bun.
  - `docs/plans/01-peer-rust-pr-reviewer/` (this plan folder).
- Local toolchain verified on machine:
  - `bun`: `1.4.0`
  - `cargo`: `1.96.1`
  - `git`: `2.53.0`
  - `gh`: `2.95.0`
- Inspection of `@opencode/client@2.3.2`, `@opencode/protocol@2.3.2`, and `@opencode/schema@2.3.2` in `docs/tmp/node_modules/@opencode/` confirmed:
  - `const endpoint = await Service.ensure()` discovers or starts the local OpenCode service and `const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })` creates the typed Promise client.
  - `client.session.create(input: SessionCreateInput)` accepts `{ location: { directory }, model: { providerID, id }, title, permissions }`.
  - In `@opencode/schema/dist/session.d.ts`, `SessionCreateInput.permissions` is evaluated *after* the agent's default rules (`last matching rule wins`). Starting `permissions` with `{ action: "*", resource: "*", effect: "deny" }` followed by `{ action: "read" | "grep" | "glob", resource: "*", effect: "allow" }` and `{ action: "read", resource: "*.env" | "*.env.*", effect: "deny" }` enforces read-only workspace inspection without interactive `"ask"` stalls or file/shell mutations.
  - `client.session.prompt({ sessionID, text })` enqueues a prompt turn; `await client.experimental.session.wait({ sessionID })` waits for completion; `await client.message.list({ sessionID, type: "assistant" })` returns `{ data: SessionMessage[] }` where assistant text parts are extracted via `msg.type === "assistant" ? msg.content.filter(p => p.type === "text").map(p => p.text) : []`; and `await client.session.remove({ sessionID })` deletes the session cleanly in `finally`.

## Global constraints

- **Concrete dependency pin table (`rules/10-tech-stack.md`):** Every runtime and dev dependency in `package.json` must use an exact version string (no `^`, `~`, or `>=` ranges):

  | Package | Pinned Version | Role |
  |---|---|---|
  | `@opencode/client` | `2.3.2` | OpenCode SDK (`OpenCode.make`, `Service.ensure`, `Service.headers`, session & message APIs) |
  | `@octokit/rest` | `22.0.1` | GitHub REST API v3 client (`Octokit`) for PR metadata, diffs, walkthrough comments, and `PENDING` reviews |
  | `zod` | `4.6.7` | Runtime schema validation for domain models, checkpoints, and OpenCode lens JSON outputs |
  | `@biomejs/biome` | `2.6.8` | Linter and formatter gate (dev) |
  | `typescript` | `7.0.2` | Strict static type checker `tsc --noEmit` (dev) |
  | `@types/bun` | `1.4.5` | Bun runtime and `bun:test` type definitions (dev) |

- **In-place checkout safety (no `git worktree`):** Never create git worktrees (which force multi-gigabyte duplicate Rust `target/` builds). Refuse immediately if the target repository has uncommitted tracked modifications or untracked files that conflict with checkout, and wrap both PR branch checkout and single-hunk `suggestion` verification in signal-safe restoration contexts (`SIGINT`/`SIGTERM` and `try/finally`).
- **Local storage boundary:** Store all checkpoints and generated review artifacts inside `<target-repo>/.git/peer/reviews/pr-<number>/` so `peer` never dirties the reviewed repository's working tree or untracked file list.
- **No unasked commits (`rules/30-git.md`):** Do not commit unless the user explicitly authorizes commits or the `plan-executor` controller announces commit-per-task up front without objection.
- **One implementer at a time & TDD (`rules/50-agent-conduct.md`):** Scaffold the compiling/type-checking skeleton first (`plan-orchestration`), then implement each task test-first.

## Constraints honoured

- [`rules/10-tech-stack.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/10-tech-stack.md) — Concrete version pins in `package.json` (no `^` or `~`) matching the authoritative pin table above.
- [`rules/20-doc-tree.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/20-doc-tree.md) — Plan files live under `docs/plans/01-peer-rust-pr-reviewer/`; research cited from [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md).
- [`rules/30-git.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/30-git.md) — Conventional Commits, no secrets committed, token resolution via environment variables or `gh auth token`.
- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) — Single whole-check command (`make check`) running Biome lint/format check, `tsc --noEmit`, and `bun test` after every task.
- [`rules/50-agent-conduct.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/50-agent-conduct.md) — Compiling skeleton before task execution, one implementer subagent at a time, TDD.
- [`rules/70-code-rationale.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/70-code-rationale.md) — `Why:` comments at non-obvious decision sites (signal deferral during byte restore, `READONLY_SESSION_PERMISSIONS` last-rule-wins ordering, `PENDING` draft review default, in-place checkout vs worktree).
- [`rules/80-quality-bar.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/80-quality-bar.md) & [`rules/85-minimalism.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/85-minimalism.md) — Zero warnings from Biome and `tsc --noEmit`, falsifiable fails-before tests, minimal module boundaries classified by responsibility.
- [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — Hermetic unit tests for pure domain/diff/filter logic; real temporary `git` and `cargo` repositories for checkout, Clippy, and `cargo check` suggestion verification tests; custom `fetch` transport injection into `@octokit/rest` only for out-of-process GitHub HTTP calls.
- [`skills/rust-conventions/SKILL.md`](/home/skull/.gemini/config/plugins/agent-workflow/skills/rust-conventions/SKILL.md) — PingCAP/TiKV Rust style guide checklist encoded into Lens 3 (`Idioms, Performance & Logic Lens`).

## Task index

- [`01-project-skeleton-and-domain-models.md`](01-project-skeleton-and-domain-models.md) — Scaffold `package.json`, `tsconfig.json`, `biome.json`, `Makefile`, `src/` module skeleton, Zod domain schemas, diff-range anchoring rules, and profile severity filtering.
- [`02-git-session-and-checkpoint-store.md`](02-git-session-and-checkpoint-store.md) — Implement clean-tree enforcement, GitHub remote `owner/repo` detection, signal-safe in-place PR checkout/restore session, and `.git/peer/reviews/pr-<num>/` incremental checkpoint persistence.
- [`03-github-client-and-auth-resolver.md`](03-github-client-and-auth-resolver.md) — Implement `PEER_GITHUB_TOKEN` $\rightarrow$ `GITHUB_TOKEN` $\rightarrow$ `gh auth token` resolution, PR target parsing, and `@octokit/rest` `GitHubClient` for PR discovery, diff retrieval, idempotent Walkthrough comment upsert, and `PENDING` review creation.
- [`04-rust-ground-truth-and-diff-mapper.md`](04-rust-ground-truth-and-diff-mapper.md) — Implement unified diff hunk parser/line mapper, `cargo metadata` crate-graph layer ordering, and `cargo clippy --message-format=json` diagnostic extraction.
- [`05-opencode-multi-lens-orchestrator.md`](05-opencode-multi-lens-orchestrator.md) — Implement concurrent read-only `@opencode/client` session orchestration for the Walkthrough & Architecture lens, Soundness/`unsafe`/Async lens, and Idioms/Performance/Logic lens.
- [`06-judge-pass-and-transactional-compiler-verifier.md`](06-judge-pass-and-transactional-compiler-verifier.md) — Implement finding deduplication across Clippy + lenses, diff-hunk line snapping/validation, profile gating, and transactional `cargo check` verification of candidate `suggestion` patches.
- [`07-renderers-and-cli-entrypoint.md`](07-renderers-and-cli-entrypoint.md) — Implement CodeRabbit-grade Walkthrough and inline comment Markdown formatters (with prompt sanitization), terminal report UI, `.git/peer/` report writer, and the `peer` / `peer review` Bun CLI entrypoint.

## Done-when checklist

- [ ] `package.json` pins all runtime and dev dependencies with exact versions matching the Global constraints table, and `bun install --frozen-lockfile` succeeds.
- [ ] `make check` runs `bun run lint` (`biome check src tests`), `bun run typecheck` (`tsc --noEmit`), and `bun test` with zero warnings and 100% passing tests.
- [ ] Running `peer review` inside a dirty git working tree exits non-zero immediately without fetching or mutating HEAD.
- [ ] `InPlaceCheckoutSession` restores the original symbolic branch name (or exact detached commit SHA) upon normal exit, exception, or simulated `SIGINT`/`SIGTERM`.
- [ ] `SuggestionCompilerVerifier` compile-checks candidate single-hunk `suggestion` replacements against `cargo check` in a real temporary Rust crate, preserves valid suggestions, strips non-compiling suggestions, and always restores the original file bytes even on exception or signal.
- [ ] Multi-lens orchestrator creates `@opencode/client` sessions with `READONLY_SESSION_PERMISSIONS`, runs all three lenses concurrently (`Promise.all`), cleans up sessions via `client.session.remove`, verifies the working tree stayed clean, and parses outputs through Zod schemas.
- [ ] Markdown renderer outputs the top-level Walkthrough comment (with `<!-- peer-walkthrough-comment -->`, architectural layer table, Mermaid `sequenceDiagram`, and effort/risk badges) and inline comments (`_<Type>_ | _<Severity>_`, verified ```` ```suggestion ```` block, and sanitized `<details><summary>Prompt for Coding Agents</summary>`).
- [ ] GitHub review posting via `@octokit/rest` defaults to omitting `event` (`PENDING` draft review on GitHub) unless `--submit-review` is explicitly passed, replaces any stale `PENDING` review owned by the same user, and updates existing `<!-- peer-walkthrough-comment -->` top-level comments in place.

## Verification commands

```bash
cd /home/skull/Projects/peer && make check
```

Where `make check` executes:

```bash
bun run lint && bun run typecheck && bun test
```

## Flagged gaps

- **GitHub Pending Review Deletion/Replacement on Re-Run:** GitHub's REST API allows at most one `PENDING` review per user per PR (`octokit.rest.pulls.createReview` returns `422 Unprocessable Entity` if the authenticated user already has an open `PENDING` review on that PR). Task 03 handles this explicitly by listing existing reviews on the PR for the authenticated user (`octokit.rest.pulls.listReviews`), deleting any stale `PENDING` review (`octokit.rest.pulls.deletePendingReview`), and then creating the fresh `PENDING` review.
- **Model String Resolution for `@opencode/client`:** Users can configure the model via `--model`, `PEER_MODEL`, or `MODEL` either as a bare OpenCode model ID (e.g. `hy4-flash-free`, `big-pickle` $\rightarrow$ `{ providerID: "opencode", id }`) or a `providerID/modelID` pair (e.g. `anthropic/claude-sonnet-4-5` $\rightarrow$ `{ providerID: "anthropic", id: "claude-sonnet-4-5" }`). Task 05 supports both formats and defaults to `{ providerID: "opencode", id: "hy4-flash-free" }`.
