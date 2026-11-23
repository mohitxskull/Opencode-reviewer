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

## Step 0: Preflight & Stage Discovery
Verify `peer` is installed in `PATH` and check current review state:
```bash
peer doctor
peer next [PR_NUMBER]
```
`peer next` inspects `.peer/<pr>/<short-sha>/`, warns if local git `HEAD` drifted from the cached analysis, and prints the exact next command for your current stage.
If `peer` is not installed, tell the user to install it with:
```bash
curl -fsSL https://raw.githubusercontent.com/mohitxskull/Opencode-reviewer/main/install.sh | sh
```
If the user only wants a fast local/CI deterministic check (no PR number, no GitHub token), run:
```bash
peer check --base main          # or --staged / --all-files
```
Exit codes: `0` = clean, `1` = blocking findings, `2` = tool/git/config/timeout error. Stop after reporting unless they ask for an LLM review.

## Step 1: Collect Deterministic Rust Ground Truth & Cohort Packets
Run Stage 1 on the target PR:
```bash
peer analyze <PR_NUMBER_OR_URL> [--tools deny,geiger,semver,coverage,miri|all]
```
This writes `.peer/<pr>/<short-sha>/01-analyze/`:
- `prompt-context.md` — PR overview, repo review instructions (`AGENTS.md`, `CLAUDE.md`, `peer.toml`, `.peer/learnings.json`), crate layers, symbol graph, deterministic diagnostics, and the **Review Cohorts** index.
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
3. **Review 100% of production diff hunks with strict file-path handoff:**
   - For small PRs (1 cohort), review `01-analyze/cohorts/<cohort-id>.md` directly and write `.peer/<pr>/<short-sha>/reviews/review.md`.
   - For multi-cohort PRs, **fan out parallel read-only subagents** (one per cohort file in `01-analyze/cohorts/`).
   - **Context discipline:** Instruct each subagent to write its Structured Markdown findings directly to `.peer/<pr>/<short-sha>/reviews/<cohort-id>.md` and return **ONLY the file path + a 1-line finding count** (never paste full findings back into the main session).
   - Write the walkthrough to `.peer/<pr>/<short-sha>/reviews/walkthrough.md`.
4. Finalize all cohort review files in one command:
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --from .peer/<pr>/<short-sha>/reviews --strict
   ```
   `peer finalize` merges all `.md` files (including standalone `walkthrough.md`), deduplicates against Stage 1 ground truth, snaps line ranges, verifies every inline ```` ```rust ```` suggestion with crate-scoped `cargo check -p <crate>`, and writes:
   - `.peer/<pr>/<short-sha>/02-review/report.md` & `.peer/<pr>/<short-sha>/review.md`
   - `.peer/<pr>/<short-sha>/todo.md` — Dependency-ordered `P0`–`P3` fix queue grouped by shared root cause/file.

## Step 3: Optional Adversarial Skeptic Pass
When the user asks for skeptic verification (or the PR is high-risk):
1. Load the skeptic prompt with `peer prompt skeptic`.
2. Read `.peer/<pr>/<short-sha>/02-review/skeptic/index.json` — `peer finalize` automatically slices all candidate findings (`fp-*` and `audit-ast-*`) into self-contained per-subsystem skeptic packets (`02-review/skeptic/skeptic-<NN>-<slug>.md`).
3. Fan out parallel read-only skeptic subagents (one per packet in `02-review/skeptic/`) to independently verify or disprove each finding against the codebase.
4. Combine their `- <finding-id> | KEEP|DROP | <reason>` lines into `.peer/<pr>/<short-sha>/verdicts.md` and apply them deterministically:
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --verdicts .peer/<pr>/<short-sha>/verdicts.md --strict
   ```
   This prints a **Skeptic Verdict Ledger** (exact before/after counts and dropped IDs) and updates `.peer/<pr>/<short-sha>/03-verify/report.md`, `review.md`, and `todo.md`.

## Step 4: Optional GitHub PR Publish
Only when the user explicitly asks to post to GitHub:
```bash
peer publish <PR_NUMBER_OR_URL>            # Posts PENDING draft review (safe default)
peer publish <PR_NUMBER_OR_URL> --submit   # Submits immediately as COMMENT
```
