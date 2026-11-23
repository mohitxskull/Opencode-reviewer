---
name: peer-review
description: >-
  Review a Rust Pull Request using the local `peer` deterministic ground-truth engine
  (clippy, cargo-audit, Cargo.lock diff, Tree-sitter AST symbol graph, plus optional
  deny/geiger/semver/coverage/miri) followed by multi-lens Rust review, optional
  adversarial skeptic verification, transactional `cargo check` suggestion verification,
  and optional GitHub PR publishing.
---

# Peer Rust PR Review Workflow

Use this skill when the user asks to review a Rust Pull Request (e.g., "review PR #42", "run peer on PR 42", or passes a GitHub PR URL).

## Prerequisites

- The `peer` CLI binary is available in `PATH` (or via `bun run /path/to/peer/src/cli/index.ts`).
- The target Rust repository has a clean git working tree.

## 4-Stage Workflow

### Stage 1: Deterministic Rust Ground Truth (`peer analyze`)
Run `peer analyze` first. It checks out the PR commit safely, collects `cargo metadata`, `cargo clippy`, `cargo audit` (base-vs-head CVE delta), `Cargo.lock` dependency delta, Tree-sitter AST symbol/`unsafe`/`#[cfg(test)]` graph, and any requested optional tools (`--tools deny,geiger,semver,coverage,miri` or `--tools all`):

```bash
peer analyze <PR_NUMBER_OR_URL> [--tools deny,geiger,semver,coverage,miri] [--profile quiet|chill|assertive]
```

This writes `.peer/<pr>/<short-sha>/01-analyze/`:
- `prompt-context.md` — Curated, line-numbered diff hunks, crate layers, Clippy/CVE ground truth, symbol graph, and repository learnings.
- `report.md` — Standalone deterministic report (stop here if the user only asked for deterministic analysis).
- `tools/*.json` — Raw structured output from every Rust analyzer.

### Stage 2: Multi-Lens Review (Using Your Own Model / Subagents)
1. Read `.peer/<pr>/<short-sha>/01-analyze/prompt-context.md`.
2. Review the PR through the 3 specialized Rust lenses in `references/`:
   - `references/walkthrough.md` — Architectural walkthrough, layered change table, sequence diagram, triage score.
   - `references/soundness.md` — Memory safety, `unsafe` invariants, async/lock-across-await deadlocks, panic paths, CVE reachability.
   - `references/idioms.md` — Logic bugs, error handling, API idioms, dead code, resource leaks.
   - Follow `references/findings-format.md` strictly for every finding and ```` ```rust ```` suggestion block.
3. Combine the walkthrough and findings into `.peer/<pr>/<short-sha>/agent-review.md` and run `peer finalize`:

```bash
peer finalize <PR_NUMBER_OR_URL> --from .peer/<pr>/<short-sha>/agent-review.md
```

`peer finalize` deduplicates findings against Stage 1 ground truth, snaps ranges to valid diff hunks, runs transactional `cargo check` on every inline Rust suggestion (stripping any suggestion that fails to compile), and writes `.peer/<pr>/<short-sha>/02-review/report.md` + `.peer/<pr>/<short-sha>/review.md`.

### Stage 3: Optional Adversarial Skeptic Pass (`--stage verify`)
If the user asks for skeptic verification (or the PR is high-risk):
1. Read `references/skeptic.md` and try to disprove each LLM finding in `02-review/bundle.json` against the actual codebase.
2. Save the surviving findings to `.peer/<pr>/<short-sha>/agent-verified.md` and finalize into Stage 3:

```bash
peer finalize <PR_NUMBER_OR_URL> --from .peer/<pr>/<short-sha>/agent-verified.md --stage verify
```

### Stage 4: Optional GitHub PR Publish (`peer publish`)
Only when the user explicitly asks to post to GitHub:

```bash
peer publish <PR_NUMBER_OR_URL>            # Posts PENDING draft review (safe default)
peer publish <PR_NUMBER_OR_URL> --submit   # Submits immediately as COMMENT
```
