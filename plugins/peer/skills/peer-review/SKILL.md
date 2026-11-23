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

Use `peer` as the deterministic Rust ground-truth & verification engine while using your own LLM capabilities and subagents for deep code reasoning.

## Step 0: Preflight Check
Verify `peer` is installed in `PATH`:
```bash
peer doctor
```
If `peer` is not installed, tell the user to install it with:
```bash
curl -fsSL https://raw.githubusercontent.com/mohitxskull/Opencode-reviewer/main/install.sh | sh
```
If the user only wants a fast local/CI deterministic check (no PR number, no GitHub token), run:
```bash
peer check --base main
```
Stop after reporting the findings unless they ask for an LLM review.

## Step 1: Collect Deterministic Rust Ground Truth
Run Stage 1 on the target PR (checks out the PR safely, runs clippy, base-vs-head `cargo-audit`, `Cargo.lock` diff, Tree-sitter AST symbol/`unsafe`/panic detectors, sensitive-file checks, and any requested `--tools`):
```bash
peer analyze <PR_NUMBER_OR_URL> [--tools deny,geiger,semver,coverage,miri|all]
```
This writes `.peer/<pr>/<short-sha>/01-analyze/`:
- `prompt-context.md` — Line-numbered diff hunks, crate dependency layers, Clippy/CVE/AST ground truth, symbol graph, and repository learnings.
- `report.md` — Standalone deterministic report (stop here if the user only asked for Stage 1).
- `tools/*.json` — Raw structured analyzer outputs.

## Step 2: Multi-Lens Rust Review + Compile-Verified Finalization
1. Read `.peer/<pr>/<short-sha>/01-analyze/prompt-context.md`.
2. Load the exact lens prompts directly from the `peer` binary (single source of truth):
   ```bash
   peer prompt walkthrough
   peer prompt soundness
   peer prompt idioms
   ```
3. Audit the PR through those 3 lenses (use parallel read-only subagents when available). Inspect surrounding files in the repo as needed to verify hypotheses before reporting.
4. Write the combined Structured Markdown output (following `peer prompt format`) to `.peer/<pr>/<short-sha>/agent-review.md`, then run:
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --from .peer/<pr>/<short-sha>/agent-review.md --strict
   ```
   `peer finalize` deduplicates findings against Stage 1 ground truth, snaps line ranges, verifies every inline ```` ```rust ```` suggestion with crate-scoped `cargo check -p <crate>`, and writes `.peer/<pr>/<short-sha>/02-review/report.md` + `.peer/<pr>/<short-sha>/review.md`.

## Step 3: Optional Adversarial Skeptic Pass
When the user asks for skeptic verification (or the PR is high-risk):
1. Load the skeptic prompt with `peer prompt skeptic` and read `.peer/<pr>/<short-sha>/02-review/bundle.json`.
2. Independently try to disprove each LLM finding (`fp-...`) against the codebase.
3. Write `KEEP` / `DROP` verdicts (`- fp-<id> | KEEP|DROP | <reason>`) to `.peer/<pr>/<short-sha>/verdicts.md` and apply them deterministically:
   ```bash
   peer finalize <PR_NUMBER_OR_URL> --verdicts .peer/<pr>/<short-sha>/verdicts.md --strict
   ```
   This updates `.peer/<pr>/<short-sha>/03-verify/report.md` and `.peer/<pr>/<short-sha>/review.md`.

## Step 4: Optional GitHub PR Publish
Only when the user explicitly asks to post to GitHub:
```bash
peer publish <PR_NUMBER_OR_URL>            # Posts PENDING draft review (safe default)
peer publish <PR_NUMBER_OR_URL> --submit   # Submits immediately as COMMENT
```
