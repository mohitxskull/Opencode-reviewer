# Task 04 — Rust Ground Truth and Diff Mapper

## Goal

Implement the unified diff parser (`parseUnifiedDiff`) in `src/diff.ts` that maps `git diff <base>..<head>` output into valid GitHub right-side (`NEW`) commentable line intervals, and the local Rust ground-truth collector in `src/rust.ts` that runs `cargo metadata` to build the workspace crate dependency graph (for architectural layer ordering of modified files) and `cargo clippy --workspace --all-targets --message-format=json` to capture structured compiler and linter diagnostics on the checked-out PR commit.

## Files touched

- `src/diff.ts` (implement)
- `src/rust.ts` (implement)
- `tests/diff.test.ts` (create)
- `tests/rust.test.ts` (create)

## Deliverable

1. `src/diff.ts`:
   - `parseUnifiedDiff(diffText: string): Record<string, DiffFileMap>` parsing unified diff headers (`--- a/...`, `+++ b/...`, `@@ -oldStart,oldCount +newStart,newCount @@`) into per-file `DiffFileMap` objects containing right-side (`NEW`) `DiffHunk` line ranges, added/context line numbers, and hunk text snippets with explicit right-side line numbers annotated (`L0042 (+): <code>`) so lens agents never miscount line offsets.
   - `snapRangeToHunk(fileMap: DiffFileMap, startLine: number, endLine: number, maxDistance?: number): { startLine: number; endLine: number } | null` validating whether `[startLine, endLine]` lies inside a single right-side hunk, or snapping slightly off-by-N line ranges (within `maxDistance = 3` lines of a single hunk boundary) into that hunk, returning `null` if the range cannot be anchored to a single hunk.
2. `src/rust.ts`:
   - `collectCrateGraph(repoRoot: string): Promise<CrateGraph>` executing `cargo metadata --format-version 1 --no-deps`, mapping each workspace member crate's manifest directory, targets, and internal workspace dependencies, and computing topological layer depth (`0` for leaf/core crates with no internal workspace dependencies $\rightarrow$ higher layers for dependent domain/service/CLI crates, with `tests/` and `benches/` placed in the verification layer) to sort modified files in architectural dependency order.
   - `collectClippyDiagnostics(repoRoot: string, modifiedFiles: ReadonlySet<string>): Promise<ClippyDiagnostic[]>` executing `cargo clippy --workspace --all-targets --message-format=json`, parsing `reason === "compiler-message"` JSON lines, normalizing workspace-relative file paths, keeping all workspace compilation errors (`level === "error"`) plus warnings/lints (`level === "warning"`) whose primary span touches `modifiedFiles`, and extracting any machine-applicable `suggested_replacement` from rustc spans.

## Constraints honoured

- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) & [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — `tests/diff.test.ts` tests pure diff parsing and line snapping hermetically; `tests/rust.test.ts` runs `collectCrateGraph` and `collectClippyDiagnostics` against a real temporary multi-crate Cargo workspace on disk (invoking real `cargo metadata` and `cargo clippy`).
- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.1, §3.3, §3.4) — Orders modified files by real `cargo metadata` crate-graph layer rather than alphabetical filename, and feeds real local `cargo clippy` diagnostics and machine-applicable replacements into the review pipeline.

## Named tests (bodies omitted)

- `tests/diff.test.ts::"parseUnifiedDiff maps right-side hunks and annotates explicit line numbers"` — Asserts that a multi-file, multi-hunk unified diff with additions, deletions, and context lines produces exact right-side (`NEW`) `[newStart, newEnd]` hunk intervals, ignores deleted-file (`+++ /dev/null`) entries for right-side anchoring, and prefixes right-side lines with `L<lineNo>:`.
- `tests/diff.test.ts::"snapRangeToHunk preserves valid ranges, snaps near-boundary ranges, and rejects cross-hunk ranges"` — Asserts that `snapRangeToHunk` preserves an in-hunk range `(12, 15)`, clamps a boundary-adjacent range `(9, 12)` into a hunk starting at line `10` when within `maxDistance = 3`, and returns `null` when a range spans across two disjoint hunks or is far outside any hunk.
- `tests/rust.test.ts::"collectCrateGraph orders leaf crates before dependent crates and tests"` — Against a real temporary 2-crate Cargo workspace (`core_crate` depended on by `api_crate`, plus `api_crate/tests/integration.rs`), asserts that `collectCrateGraph` assigns `core_crate/src/lib.rs` layer `0`, `api_crate/src/lib.rs` layer `1`, and `api_crate/tests/integration.rs` the test layer.
- `tests/rust.test.ts::"collectClippyDiagnostics extracts warnings on modified files and filters untouched files"` — Against a real temporary Cargo crate containing a deliberate Clippy warning in a modified file and another warning in an unmodified file, asserts that `collectClippyDiagnostics` captures the diagnostic on the modified file (with exact `filePath`, `startLine`, `endLine`, `code`, `message`, and `rendered`) while filtering out warnings on untouched files.

## Code-only decisions

```ts
// Why: LLMs frequently miscount line numbers when reading raw `@@ -a,b +c,d @@`
// unified diff hunks containing interleaved `-` and `+` lines. Pre-rendering
// each right-side (context or `+`) line with its explicit `L0042 (+):` prefix
// inside the context package eliminates off-by-one line anchoring errors at the source.
export function formatAnnotatedDiffLine(lineNo: number, marker: "+" | " ", content: string): string {
  return `L${String(lineNo).padStart(4, "0")} (${marker}): ${content}`;
}
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests` and `tsc --noEmit` pass with zero issues.
- `bun test` runs `tests/diff.test.ts` and `tests/rust.test.ts` (including real `cargo metadata` and `cargo clippy` invocations) with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(rust,diff): add unified diff line mapper and cargo metadata/clippy collector
```

## Done-when

- [ ] `parseUnifiedDiff` parses right-side hunks and produces explicit `L<num>:` annotated diff views.
- [ ] `snapRangeToHunk` enforces single-hunk containment and boundary snapping.
- [ ] `collectCrateGraph` parses `cargo metadata --format-version 1 --no-deps` and computes topological crate layer order.
- [ ] `collectClippyDiagnostics` runs `cargo clippy --workspace --all-targets --message-format=json` and filters warnings to modified files while keeping all workspace compile errors.
- [ ] All tests in `tests/diff.test.ts` and `tests/rust.test.ts` pass via `make check`.
