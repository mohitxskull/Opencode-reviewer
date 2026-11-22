# Task 06 — Judge Pass and Transactional Compiler Verifier

## Goal

Implement the two-stage verification filter that turns raw candidate findings into compiler-verified, zero-hallucination review comments:
1. **Judge Pass (`src/judge.ts`)**: Synthesizes unhandled `ClippyDiagnostic` records with lens findings, deduplicates overlapping findings across lenses + Clippy, validates/snaps every finding's file path and `[startLine, endLine]` range against the PR's `DiffFileMap` (dropping unanchorable findings), and applies the active `ReviewProfile` (`quiet`, `chill`, `assertive`).
2. **Transactional Suggestion Compiler Verifier (`src/verifier.ts`)**: For every surviving finding that proposes a `suggestion` code replacement block, transactionally patches `[startLine..endLine]` in the working tree, runs `cargo check --workspace --all-targets --message-format=json`, immediately restores the exact original file bytes (with `SIGINT`/`SIGTERM` deferred during the patch-and-restore critical section), and strips any `suggestion` block that fails to compile while keeping the finding's explanation and coding-agent prompt.

## Files touched

- `src/judge.ts` (implement)
- `src/verifier.ts` (implement)
- `tests/judge.test.ts` (create)
- `tests/verifier.test.ts` (create)

## Deliverable

1. `src/judge.ts`:
   - `clippyToFindings(diagnostics: readonly ClippyDiagnostic[], diffMap: Readonly<Record<string, DiffFileMap>>): Finding[]` converting actionable Clippy warnings/errors on modified diff hunks into `Finding` objects (incorporating rustc's machine-applicable `suggestedReplacement` when single-hunk).
   - `deduplicateAndFilterFindings(findings: readonly Finding[], diffMap: Readonly<Record<string, DiffFileMap>>, profile: ReviewProfile): Finding[]` performing:
     - Diff-hunk anchoring via `snapRangeToHunk` (dropping findings on non-existent files or lines outside modified diff hunks).
     - Overlap clustering: when two findings target the same file and overlapping line ranges (`Math.max(a.startLine, b.startLine) <= Math.min(a.endLine, b.endLine)`), merges them if they describe the same defect category or keeps the higher-severity / compiler-backed finding (preferring a finding with a concrete `suggestion` block and combining complementary context into `agentPrompt`).
     - Profile gating via `allowsFindingForProfile(profile, finding)` and deterministic sorting by `(severityRank, filePath, startLine)`.
2. `src/verifier.ts`:
   - `SuggestionCompilerVerifier.verifySuggestions(repoRoot: string, findings: readonly Finding[]): Promise<Finding[]>`:
     - Snapshots the target file's raw `Uint8Array` bytes (`await Bun.file(targetPath).bytes()`) before touching disk.
     - Defers `SIGINT`/`SIGTERM` termination while the temporary edit is on disk, writes the candidate `suggestion` replacement for lines `[startLine..endLine]` preserving original line endings, runs `cargo check --workspace --all-targets --message-format=json`, and unconditionally writes back the exact original `Uint8Array` bytes in `finally` before re-raising any deferred signal.
     - Marks `finding.suggestionVerified = true` when `cargo check` exits `0` (with zero compiler errors), or strips `finding.suggestion = null` (`finding.suggestionVerified = false`, appending the compiler error summary to `finding.agentPrompt`) when `cargo check` fails so a broken one-click GitHub suggestion is never published.

## Constraints honoured

- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) & [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — `tests/verifier.test.ts` executes `SuggestionCompilerVerifier` against a real temporary Cargo crate on disk using real `cargo check` (never mocking `cargo check` in the integration test).
- [`rules/70-code-rationale.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/70-code-rationale.md) — Document why `SuggestionCompilerVerifier` snapshots and restores raw `Uint8Array` bytes (rather than re-encoding decoded text lines) and defers `SIGINT`/`SIGTERM` until restoration finishes.
- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.2, §3.3, §3.4) — Solves CodeRabbit's #1 Rust limitation (unverified single-hunk `suggestion` blocks that fail `rustc` borrow/type checking) and implements the Judge deduplication + profile filtering pass.

## Named tests (bodies omitted)

- `tests/judge.test.ts::"deduplicateAndFilterFindings merges overlapping Clippy and lens findings keeping highest severity"` — Asserts that when Clippy and a lens both report an issue on overlapping lines of the same file, `deduplicateAndFilterFindings` emits a single merged `Finding` with the higher severity, preserved `suggestion`, and combined `agentPrompt`.
- `tests/judge.test.ts::"deduplicateAndFilterFindings drops findings outside diff hunks and applies profile gate"` — Asserts that findings targeting unmodified lines far from any diff hunk are dropped, slightly offset lines within 3 lines of a hunk boundary are snapped into the hunk, and `"quiet"` / `"chill"` / `"assertive"` profiles filter the surviving list accurately.
- `tests/verifier.test.ts::"verifySuggestions keeps valid compiling Rust suggestion and restores exact file bytes"` — Against a real temporary Cargo crate, passes a `Finding` with a valid compiling Rust `suggestion` replacement, asserts `verifySuggestions` sets `suggestionVerified: true` and preserves `finding.suggestion`, and asserts the file on disk has its exact original pre-verification SHA-256 byte hash afterwards.
- `tests/verifier.test.ts::"verifySuggestions strips non-compiling Rust suggestion and records compiler error in agentPrompt"` — Against a real temporary Cargo crate, passes a `Finding` whose `suggestion` introduces a Rust type/borrow error (`E0308` / `E0382`), asserts `verifySuggestions` strips `finding.suggestion` to `null`, sets `suggestionVerified: false`, appends the `rustc` error hint to `finding.agentPrompt`, and restores the exact original file bytes on disk.
- `tests/verifier.test.ts::"verifySuggestions restores original file bytes when check runner throws mid-flight"` — Simulates an exception raised while the candidate patch is written to disk and asserts that the target Rust source file's exact original bytes are restored before the error propagates.

## Code-only decisions

```ts
// Why: Re-joining decoded UTF-8 lines can normalize CRLF/LF or trailing newline
// bytes, leaving the user's checked-out working tree dirty according to `git status`.
// Snapshotting `originalBytes = await Bun.file(targetPath).bytes()` and writing
// `originalBytes` back verbatim in `finally` guarantees bit-for-bit restoration
// after `cargo check`.
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests` and `tsc --noEmit` pass with zero issues.
- `bun test` runs `tests/judge.test.ts` and `tests/verifier.test.ts` (including real `cargo check` compilation tests) with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(judge,verifier): add finding deduplication and transactional cargo check suggestion verifier
```

## Done-when

- [ ] `deduplicateAndFilterFindings` merges overlapping Clippy + lens findings, snaps/validates diff hunk line ranges, and enforces `ReviewProfile`.
- [ ] `SuggestionCompilerVerifier` compile-checks candidate `suggestion` blocks with real `cargo check`, preserves valid suggestions, strips broken ones, and restores exact file bytes under all exit/signal paths.
- [ ] All tests in `tests/judge.test.ts` and `tests/verifier.test.ts` pass via `make check`.
