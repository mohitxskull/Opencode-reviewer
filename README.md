# Peer — Local-First Rust PR Reviewer (OpenCode SDK + Octokit)

`peer` is a local-first GitHub Pull Request reviewer built in **100% TypeScript on Bun**, powered by **`@opencode/client`** (OpenCode SDK, supporting free models like `hy4-flash-free` and `big-pickle`) and **`@octokit/rest`**.

Designed specifically for **complex Rust workspaces**, `peer` runs directly inside your local dev repository with your warm `target/` build cache—combining architectural PR walkthroughs and surgical inline comments with real `cargo clippy`, cross-workspace Rust symbol call-site graphs, native Rust soundness/concurrency/idiom audit rules, and transactional `cargo check` verification of every proposed ```` ```suggestion ```` block.

## Key Capabilities

- **In-Place Checkout with Clean-Tree Gate & Signal-Safe Restoration:** Refuses to run if your working tree has uncommitted changes, checks out the PR commit in detached HEAD (reusing your warm `target/` cache without multi-GB worktree duplication), and guarantees restoration of your original branch on exit, error, or `SIGINT`/`SIGTERM`.
- **Local Rust Ground Truth (`cargo metadata` + `cargo clippy` + Symbol Call-Site Graph):**
  - Orders modified files by topological Cargo crate dependency layer (`L0` leaf/core crates $\rightarrow$ dependent crates $\rightarrow$ test layer).
  - Extracts `cargo clippy --workspace --all-targets --message-format=json` diagnostics.
  - Builds a cross-workspace **Rust Symbol & Call-Site Graph** via `git grep -n -w` in <50ms, surfacing 0-caller methods and production vs. test call sites.
- **Subsystem Cohort Sharding & Native Rust Audit Rules:**
  - Filters out non-code files (`.md`, `docs/`, lockfiles) and shards multi-file PRs into balanced subsystem cohorts so every production Rust file receives a deep audit for soundness, concurrency, state-machine invariants, and PingCAP/TiKV Rust conventions.
- **Transactional `cargo check` Suggestion Verifier:**
  - Every candidate ```` ```suggestion ```` block is transactionally patched onto disk, compile-checked with `cargo check --workspace --all-targets`, and immediately restored bit-for-bit (`Uint8Array` snapshot). Broken suggestions that fail to compile are automatically stripped before posting.
- **CodeRabbit-Grade Output & Safe GitHub Posting:**
  - Top-level PR Walkthrough comment (`<!-- peer-walkthrough-comment -->`) with effort/risk triage score, architectural layer table, and Mermaid `sequenceDiagram`.
  - Inline diff comments (`_Type_ | _Severity_`, verified ```` ```suggestion ```` blocks, and sanitized `<details><summary>Prompt for Coding Agents</summary>`), collapsible **⚠️ Outside diff range comments**, and **🧹 Nitpick comments**.
  - Posts inline reviews as a **`PENDING` (draft) GitHub PR review** by default (`--submit-review` to publish immediately as `COMMENT`).
- **Live CLI Stage Progress & Streaming JSONL Audit Log:**
  - Streams live stage, cohort, and `cargo check` progress with elapsed timers (`[MM:SS.s]`) and writes a detailed append-only JSONL audit trail to `.git/peer/reviews/pr-<num>/audit.jsonl` (and `.git/peer/reviews/pr-<num>/runs/run-<id>.jsonl`).
- **Persistent Repository Learnings:**
  - Store global or path-scoped rules locally in `.git/peer/learnings.json` via `peer learn add|list|remove`.

## Installation

```bash
bun install
make check
```

## Usage

```bash
# Review PR #23 locally (writes walkthrough.md, review.md, findings.json, and audit.jsonl to .git/peer/reviews/pr-23/)
bun src/cli.ts review 23 --repo /path/to/rust-repo --local-only

# Review by PR number or full URL and post Walkthrough + PENDING draft review to GitHub
bun src/cli.ts review https://github.com/owner/repo/pull/23 --repo /path/to/rust-repo --post

# Submit review immediately on GitHub instead of PENDING draft
bun src/cli.ts review 23 --post --submit-review

# Override OpenCode model (defaults to opencode/hy4-flash-free)
bun src/cli.ts review 23 --model big-pickle --local-only

# Manage repository learnings
bun src/cli.ts learn add "Dual account snapshots are reconciled at barrier points." --scope "src/services/**"
bun src/cli.ts learn list
bun src/cli.ts learn remove <id>
```
