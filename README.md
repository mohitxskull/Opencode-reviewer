# Peer — Agent-Agnostic Rust PR Ground-Truth & Verification Engine

`peer` is a local-first Rust Pull Request analysis, suggestion-verification, and GitHub publishing engine built in **TypeScript on Bun** (`1.4+`).

Instead of locking you into one LLM SDK, `peer` handles everything deterministic that LLMs cannot do reliably — running directly inside your local Rust workspace with your warm `target/` cache — and pairs with thin native plugins for **Antigravity**, **OpenCode**, **Claude Code**, **Cursor**, or any coding agent.

## How It Works (4-Stage Composable Pipeline)

Every stage writes its own report and structured artifacts to `.peer/<pr-number>/<short-sha>/` (auto-excluded via `.git/info/exclude` so `git status` stays clean) and short-circuits immediately when a commit has already been processed:

1. **Stage 1 — `peer analyze [PR]` (0 LLM calls):**
   - Enforces a clean working tree, checks out the PR commit in detached HEAD (signal-safe LIFO restoration on exit, error, or `SIGINT`/`SIGTERM`), and computes the 3-dot merge-base diff.
   - Runs core deterministic Rust analyzers with a scrubbed Cargo environment (no GitHub/AWS/SSH secrets leaked to `build.rs` or proc-macros):
     - `cargo metadata` — topological crate dependency layers (`L0` core → dependents → tests)
     - `cargo clippy --workspace --all-targets --message-format=json` — hunk-filtered diagnostics + multi-span suggestion splicing
     - `cargo audit --json` — base-vs-head CVE/RustSec delta (only newly introduced advisories)
     - `Cargo.lock` TOML diff — added, upgraded, and removed dependencies (`Bun.TOML.parse`)
     - **Tree-sitter Rust AST** (`web-tree-sitter` + `tree-sitter-rust`) — exact enclosing symbol spans, `unsafe` regions, inline `#[cfg(test)]` classification, and cross-workspace call-site graph
   - Optional analyzers via `--tools <list|all>` (fail-loud with install instructions if missing):
     - `deny` (`cargo-deny` — auto-runs if `deny.toml` exists)
     - `geiger` (`cargo-geiger` — unsafe-code surface in modified workspace crates)
     - `semver` (`cargo-semver-checks` — breaking public API changes vs `pr.baseSha`)
     - `coverage` (`cargo-llvm-cov` — untested changed production lines, excluding tests & inline `#[cfg(test)]`)
     - `miri` (`cargo +nightly miri test` — Tree-sitter AST-gated: only runs on crates whose diff touches `unsafe` regions)
   - Writes `.peer/<pr>/<short-sha>/01-analyze/{report.md,prompt-context.md,context.json,bundle.json,tools/*.json}`.

2. **Stage 2 — Agent Multi-Lens Review + `peer finalize [PR] --from <file>`:**
   - Any coding agent (Antigravity, OpenCode, Claude Code, Cursor) reads `01-analyze/prompt-context.md` and reviews the PR using its own model/subagents and the bundled Rust lens prompts (`walkthrough`, `soundness`, `idioms`).
   - `peer finalize` parses the agent's Structured Markdown (or JSON) output, merges and deduplicates it with Stage 1 ground truth, snaps ranges to valid GitHub diff hunks, runs **transactional `cargo check`** on every inline ```` ```rust ```` suggestion (bit-for-bit byte restoration; non-compiling suggestions are stripped), and writes `02-review/report.md` + top-level `review.md`.

3. **Stage 3 — Optional Skeptic Verification (`peer finalize [PR] --from <file> --stage verify`):**
   - Run an adversarial skeptic pass to disprove false positives and save the verified bundle to `03-verify/`.

4. **Stage 4 — `peer publish [PR]` (0 builds, 0 LLM calls):**
   - Uploads the latest saved stage (`03-verify` → `02-review` → `01-analyze`) to GitHub as a Walkthrough comment + **`PENDING` draft review** by default (`--submit` to publish immediately as `COMMENT`), and updates the incremental review checkpoint.

## `.peer/` Artifact Layout

```text
.peer/
├── learnings.json                    # Optional version-controlled repo rules (`peer learn ...`)
└── <pr-number>/<short-sha>/          # Auto-ignored via .git/info/exclude
    ├── run.json                      # Pipeline manifest (completedStages, counts, timings)
    ├── review.md                     # Always mirrors the latest completed stage's report.md
    ├── audit.jsonl                   # Streaming execution event log
    ├── 01-analyze/
    │   ├── report.md                 # Standalone deterministic report (0 LLM calls)
    │   ├── prompt-context.md         # Curated context package for any coding agent
    │   ├── context.json              # Saved diffMap, crateGraph, baseline, findings
    │   ├── bundle.json
    │   └── tools/{clippy,audit,symbol-graph,cargo-lock-diff,deny,geiger,semver,coverage,miri}.json
    ├── 02-review/
    │   ├── report.md                 # Post-Judge, cargo-check-verified report
    │   ├── walkthrough.md
    │   └── bundle.json
    ├── 03-verify/
    │   ├── report.md                 # Post-skeptic report
    │   ├── skeptic.json
    │   └── bundle.json
    └── 04-publish/
        └── report.md                 # GitHub publish receipt
```

## Installation & Build

```bash
bun install
make check
make build    # Compiles standalone binary -> dist/peer
```

Copy `dist/peer` into your `PATH` (e.g. `cp dist/peer ~/.local/bin/peer`).

### Install Into Your Coding CLI

1. **Install the `peer` binary** (no Bun/Node required for prebuilt releases, or `make build` from source):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/mohitxskull/Opencode-reviewer/main/install.sh | sh
   ```
2. **Add the `peer-review` skill/plugin to your coding CLI** (all coding-CLI integrations live under [`plugins/`](plugins/)):
   - **Antigravity:**
     ```bash
     agy plugin install ./plugins/peer
     ```
   - **Claude Code:**
     ```bash
     /plugin install ./plugins/peer
     ```
   - **Cursor, Codex, OpenCode, or any Agent Skills CLI (`npx skills`):**
     ```bash
     npx skills add mohitxskull/Opencode-reviewer --skill peer-review
     ```
   - **OpenCode native tools plugin:**
     Copy or symlink [plugins/opencode/index.ts](plugins/opencode/index.ts) into `.opencode/plugins/peer.ts` (or `~/.config/opencode/plugins/peer.ts`) to expose `peer_doctor`, `peer_prompt`, `peer_check`, `peer_analyze`, `peer_finalize`, and `peer_publish`.

## CLI Usage

```bash
# Stage 1: Deterministic Rust analysis only (default command)
peer analyze 42 --repo /path/to/rust-repo
peer analyze https://github.com/owner/repo/pull/42 --tools deny,geiger,semver,coverage,miri
peer analyze 42 --tools all --fresh

# Stage 2 / 3: Judge merge + transactional `cargo check` suggestion verification
peer finalize 42 --from .peer/42/<sha>/agent-review.md
peer finalize 42 --from .peer/42/<sha>/agent-verified.md --stage verify

# Stage 4: Upload latest saved stage to GitHub PR
peer publish 42            # Posts PENDING draft review
peer publish 42 --submit   # Submits immediately as COMMENT

# Scaffold repository configuration (peer.toml)
peer init

# Manage persistent repository learnings
peer learn add "Avoid holding std::sync::Mutex across .await" --scope "src/services/**"
peer learn list
peer learn remove <id>
```

### Repository Configuration (`peer.toml`)
Run `peer init` to create a `peer.toml` in your repository root. During PR reviews, `peer.toml` is always loaded strictly from `pr.baseSha` (never from untrusted PR head commits), and explicit CLI flags override `peer.toml`:

```toml
profile = "chill"

[tools]
clippy = true
audit = true
deny = false
geiger = false
semver = true
coverage = false
miri = true

[diff]
ignore = ["**/generated/**", "**/*.pb.rs"]

[publish]
mode = "draft"

[[rules]]
scope = "src/oms/**"
rule = "Never hold std::sync::Mutex across .await; use parking_lot::Mutex."
```

### GitHub Authentication Precedence
1. `PEER_GITHUB_TOKEN` environment variable
2. `GITHUB_TOKEN` environment variable
3. OS Keychain via `Bun.secrets` (`service: "peer-cli"`, `name: "github-token"`)
4. `gh auth token` CLI fallback

## Architecture & Development

```text
src/
├── cli/         # CLI entrypoint (index.ts) & `peer learn` subcommand
├── pipeline/    # Composable stages: analyze.ts, finalize.ts, publish.ts
├── analyzers/   # All deterministic Rust analyzers (ast, rust, symbol-graph, security, deny, geiger, semver, coverage, miri)
├── llm/         # Agent context builders, cohort scoring, Structured Markdown/JSON parser, lens prompts
├── judge/       # Finding dedup/hunk-snapping (partition.ts) & transactional `cargo check` verifier
├── render/      # Pure Markdown & Bun.inspect.table terminal renderers
├── workspace/   # `.peer/` stage artifacts, git checkout session, checkpoints, learnings, JSONL audit log
├── github/      # Octokit REST client & token resolution
├── domain/      # Zod schemas, unified diff parser, template filler
└── infra/       # Scrubbed Cargo env, Bun.JSONL recovery parser, LIFO signal cleanup
```

```bash
make fmt      # bun fmt (configured via bunfig.toml)
make check    # bun fmt --check && biome lint && bun check && bun test
make build    # bun build src/cli/index.ts --compile --outfile dist/peer
```
