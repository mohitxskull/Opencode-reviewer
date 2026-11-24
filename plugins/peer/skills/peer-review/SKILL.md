---
name: peer-review
description: >-
  Review a Rust Pull Request or local Rust branch using `peer` (deterministic Cargo
  ground truth: clippy, cargo-audit, Cargo.lock diff, Tree-sitter AST unsafe/panic
  detectors, plus optional deny/geiger/semver/coverage/miri) followed by multi-lens
  Rust review, deterministic skeptic verdicts, transactional `cargo check` suggestion
  verification, and optional GitHub PR publishing. Trigger when the user asks to
  review a Rust PR, run `peer`, audit a Rust branch, or check Rust changes before push.
license: MIT
---

# Peer Rust PR Review Workflow

Use `peer` as the deterministic Rust ground-truth & verification engine while using your own LLM capabilities and parallel subagents for deep code reasoning.

## Step 0: Preflight & Stage Discovery (Agent-First JSON Mode)
If you are running inside OpenCode with the `peer` plugin loaded, prefer the native `peer_doctor`, `peer_init`, `peer_next`, `peer_analyze`, `peer_finalize`, `peer_publish`, `peer_check`, and `peer_learn` tools (which automatically pass `--json`). Otherwise, pass `--json` (or `--quiet` for single-line JSON) on any `peer` CLI command so you consume structured JSON directly instead of grepping Markdown tables:
```bash
peer doctor --json
peer next [PR_NUMBER] --json
```
- **Universal exit codes across all `peer` subcommands:**
  - `0` = Success (or clean gate for `peer check` / all required tools installed for `peer doctor`)
  - `1` = Blocking findings detected (`peer check`) or required toolchain missing (`peer doctor`)
  - `2` = Usage, configuration, git, network, timeout, strict-parse, or missing-cohort error
- If `peer` is not installed, tell the user to install it with:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/mohitxskull/Opencode-reviewer/main/install.sh | sh
  ```
- If the repository has no `peer.toml` or `deny.toml` yet (or the user asks to set up/onboard `peer`), run:
  ```bash
  peer init --json [--tools deny,geiger,semver,coverage,miri|all] [--install] [--baseline] [--ci]
  ```
  `peer init` inspects `cargo metadata`, writes a repo-tailored `peer.toml` and a zero-false-positive `deny.toml` seeded with the workspace's OSI-approved licenses, and optionally installs missing Cargo analyzers (`--install`), seeds `.peer/baseline.json` (`--baseline`), or scaffolds `.github/workflows/peer.yml` (`--ci`).
- If the user only wants a fast local/CI deterministic check (no PR number, no GitHub token), run:
  ```bash
  peer check --base main --json    # or --staged / --all-files
  ```
  Stop after reporting unless they ask for an LLM review.

## Step 1: Collect Deterministic Rust Ground Truth & Cohort Packets
Run Stage 1 on the target PR (omit `--tools` when `peer.toml` is already configured so `peer.toml` selects the workspace's enabled tools; only pass `--tools ...` to explicitly override; **do NOT pass `--fresh` on follow-up commits of a PR** because `peer analyze` automatically invalidates its cache when `headSha` or `--tools` changes, while `--fresh` forces a full-PR re-review from `baseSha` instead of incremental convergence):
```bash
peer analyze <PR_NUMBER_OR_URL> --json
```
This returns structured JSON (`counts`, `countsBySeverity`, `enabledTools`, `toolOutcomes`, `artifacts`, `nextCommand`) and writes `.peer/<pr>/<short-sha>/01-analyze/`:
- `prompt-context.md` — Compact orchestrator index (PR overview, repo review instructions from `AGENTS.md`/`CLAUDE.md`/`peer.toml`/`.peer/learnings.json`, crate layers, symbol graph, deterministic diagnostics, and the **Review Cohorts** index — without duplicating raw diff hunks).
- `cohorts/index.json` + `cohorts/<cohort-id>.md` — Self-contained, **untruncated** diff packets covering 100% of modified production Rust files, grouped by subsystem with matching repo instructions.
- `report.md` — Standalone deterministic report (stop here if the user only asked for Stage 1).

## Step 2: Cohort-Parallel Multi-Lens Review + Compile-Verified Finalization
1. Read `.peer/<pr>/<short-sha>/01-analyze/prompt-context.md` and `cohorts/index.json`.
2. Load the exact lens prompts directly from the `peer` binary (single source of truth):
   ```bash
   peer prompt walkthrough
   peer prompt soundness
   peer prompt idioms
   ```
3. **Review 100% of production diff hunks with zero-assembly subagent dispatch:**
   - Each entry in `01-analyze/cohorts/index.json` provides `packetPath`, `outputPath` (`.peer/<pr>/<short-sha>/reviews/<cohort-id>.md`), and a ready-to-pass `subagentBrief`.
   - For small PRs (1 cohort), read `packetPath` and write `outputPath` directly.
   - For multi-cohort PRs, **fan out parallel read-only subagents** (one per entry in `cohorts/index.json`, passing its `subagentBrief`).
   - **Strictly read-only subagents:** Subagents must **NEVER** run `cargo test`, `cargo check`, or `cargo clippy` in the shell — Stage 1 already collected compiler/analyzer ground truth, and running `cargo` inside parallel subagents contends on the `target/` lock and invalidates the build cache before `peer finalize`.
   - **Context discipline:** Each subagent writes its Structured Markdown findings directly to `outputPath` and returns **ONLY the file path + a 1-line finding count** (never paste full findings back into the main session).
   - Write the walkthrough to `.peer/<pr>/<short-sha>/reviews/walkthrough.md`.
4. Finalize all cohort review files in one command:
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --from .peer/<pr>/<short-sha>/reviews --strict --json
   ```
   `peer finalize` validates `cohortCoverage` against `01-analyze/cohorts/index.json` (returning structured `missingCohortIds` and `malformedBlocks` if any subagent failed or wrote a malformed block), deduplicates against Stage 1 ground truth, snaps line ranges, verifies every inline ```` ```rust ```` suggestion with crate-scoped `cargo check -p <crate>`, and writes:
   - `.peer/<pr>/<short-sha>/02-review/report.md` & `.peer/<pr>/<short-sha>/review.md`
   - `.peer/<pr>/<short-sha>/todo.json` & `.peer/<pr>/<short-sha>/todo.md` — Machine-readable (`todo.json`) and human-readable (`todo.md`) dependency-ordered `P0`–`P3` fix queue with `dependsOn`, `verificationCommand`, `suggestion`, and `suggestionVerified`.
   - `.peer/<pr>/<short-sha>/02-review/skeptic/index.json` + `skeptic-<NN>-<slug>.md` — Lossless per-subsystem skeptic packets with `packetPath`, `outputPath`, and `subagentBrief`.

## Step 3: Optional Adversarial Skeptic Pass
When the user asks for skeptic verification (or the PR is high-risk):
1. Load the skeptic prompt with `peer prompt skeptic`.
2. Read `.peer/<pr>/<short-sha>/02-review/skeptic/index.json` and fan out parallel read-only skeptic subagents (passing each entry's `subagentBrief` so each subagent reads `packetPath` and writes its `- <finding-id> | KEEP|DROP | <reason>` lines directly to `outputPath` in `.peer/<pr>/<short-sha>/verdicts/`).
3. Apply all verdict files deterministically in one command (passing either the `verdicts/` directory or a single `verdicts.md` file):
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --verdicts .peer/<pr>/<short-sha>/verdicts --strict --json
   ```
   This returns structured `reconciliation` JSON (`beforeCount`, `verdictsApplied`, `keptCount`, `droppedCount`, `droppedIds`, `lockedRetainedIds`, `unmatchedVerdictIds`) and updates `03-verify/report.md`, `review.md`, `todo.json`, and `todo.md`.

## Step 4: Optional GitHub PR Publish
Only when the user explicitly asks to post to GitHub:
```bash
peer publish <PR_NUMBER_OR_URL> --json            # Posts PENDING draft review (safe default)
peer publish <PR_NUMBER_OR_URL> --submit --json   # Submits immediately as COMMENT
```
