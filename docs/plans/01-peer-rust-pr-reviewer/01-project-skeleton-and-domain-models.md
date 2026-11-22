# Task 01 — Project Skeleton and Domain Models

## Goal

Establish the `peer` TypeScript + Bun project structure under `/home/skull/Projects/peer`, pin all runtime and development dependencies in `package.json`, configure `tsconfig.json`, `biome.json`, and the single whole-check `Makefile` gate (`make check`), remove the temporary `docs/tmp/` scratch directory once dependencies are installed at the root, and implement the core Zod domain schemas, TypeScript types, severity/profile enums, diff-line anchoring helpers, and profile filtering rules in `src/models.ts`.

## Files touched

- `package.json` (create)
- `tsconfig.json` (create)
- `biome.json` (create)
- `Makefile` (create)
- `.gitignore` (create)
- `src/models.ts` (create)
- `src/git.ts` (create skeleton stubs if not already present)
- `src/github.ts` (create skeleton stubs if not already present)
- `src/diff.ts` (create skeleton stubs if not already present)
- `src/rust.ts` (create skeleton stubs if not already present)
- `src/lenses.ts` (create skeleton stubs if not already present)
- `src/judge.ts` (create skeleton stubs if not already present)
- `src/verifier.ts` (create skeleton stubs if not already present)
- `src/render/markdown.ts` (create skeleton stubs if not already present)
- `src/render/terminal.ts` (create skeleton stubs if not already present)
- `src/cli.ts` (create skeleton stubs if not already present)
- `tests/models.test.ts` (create)

## Deliverable

A locked Bun TypeScript project (`package.json` + `bun.lock`) with a working `make check` target (`bun run lint && bun run typecheck && bun test`) and complete, hermetically tested Zod schemas and domain helpers in `src/models.ts` covering PR metadata, unified diff line intervals (`DiffHunk`, `DiffFileMap`), Cargo crate-graph layers (`CrateGraph`), Clippy diagnostics (`ClippyDiagnostic`), six-tier severities (`Critical`, `Major`, `Minor`, `Trivial`, `Info`, `None`), orthogonal finding types (`Bug`, `Security`, `Soundness`, `Concurrency`, `Performance`, `Idioms`, `Refactor`), review profiles (`quiet`, `chill`, `assertive`), walkthrough reports (`WalkthroughReport`, `TriageScore`), inline findings (`Finding`), review bundles (`ReviewBundle`), and checkpoints (`ReviewCheckpoint`).

## Constraints honoured

- [`rules/10-tech-stack.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/10-tech-stack.md) — Every dependency in `package.json` uses an exact version pin (`"2.3.2"`, `"22.0.1"`, `"4.6.7"`, `"2.6.8"`, `"7.0.2"`, `"1.4.5"`) matching [`docs/plans/01-peer-rust-pr-reviewer/README.md`](README.md#global-constraints).
- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) — `Makefile` defines `check` as a single runnable command executing `bun run lint && bun run typecheck && bun test`.
- [`rules/80-quality-bar.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/80-quality-bar.md) — Zero warnings under `biome check` and `tsc --noEmit` (`strict: true`, `noUncheckedIndexedAccess: true`).
- [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — Pure domain and policy logic (`allowsFindingForProfile`, `isValidInlineRange`, `FindingSchema` line range refinements) tested via hermetic unit tests in `tests/models.test.ts`.
- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.1, §3.2) — Preserves the 6-tier severity taxonomy (`Critical`, `Major`, `Minor`, `Trivial`, `Info`, `None`), orthogonal issue type badge header, and `quiet` / `chill` / `assertive` profile gating semantics.

## Named tests (bodies omitted)

- `tests/models.test.ts::"FindingSchema rejects inverted or non-positive line ranges"` — Asserts that parsing a `Finding` with `startLine > endLine` or `startLine < 1` throws a `ZodError`.
- `tests/models.test.ts::"allowsFindingForProfile with quiet allows only Critical and Major"` — Asserts that `allowsFindingForProfile("quiet", finding)` returns `true` only for `"Critical"` and `"Major"`, and `false` for `"Minor"`, `"Trivial"`, `"Info"`, and `"None"` regardless of confidence.
- `tests/models.test.ts::"allowsFindingForProfile with chill filters low-confidence Minor and all Trivial"` — Asserts that `allowsFindingForProfile("chill", finding)` allows `"Critical"`, `"Major"`, and `"Minor"` with `confidence >= 0.80`, while rejecting `"Minor"` with `confidence < 0.80`, `"Trivial"`, `"Info"`, and `"None"`.
- `tests/models.test.ts::"allowsFindingForProfile with assertive allows all actionable severities"` — Asserts that `allowsFindingForProfile("assertive", finding)` allows `"Critical"`, `"Major"`, `"Minor"`, `"Trivial"`, and `"Info"`, and rejects only `"None"`.
- `tests/models.test.ts::"isValidInlineRange validates single-hunk containment"` — Asserts that `isValidInlineRange(fileMap, startLine, endLine)` returns `true` only when the entire `[startLine, endLine]` interval falls within a single right-side (`NEW`) diff hunk (required by GitHub's multi-line review comment API) and `false` when a range spans across two separate hunks or outside modified hunks.
- `tests/models.test.ts::"TriageScoreSchema enforces reviewEffort in 1..5 and valid mergeRisk"` — Asserts that `TriageScoreSchema` accepts integer effort scores `1` through `5` and rejects `0`, `6`, or unknown risk levels.

## Code-only decisions

```ts
// Why: GitHub's multi-line PR review comment API (start_line..line on side="RIGHT")
// rejects comments whose start_line and line belong to different diff hunks with
// 422 Unprocessable Entity. Requiring both lines to reside inside the same DiffHunk
// guarantees every surviving inline finding and ```suggestion``` block can be
// anchored and committed on GitHub.
export const CHILL_MINOR_MIN_CONFIDENCE = 0.80;
export const WALKTHROUGH_MARKER = "<!-- peer-walkthrough-comment -->";
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests`: `Checked ... files in ... No fixes applied.`
- `tsc --noEmit`: exits `0` with no output.
- `bun test`: all 6 tests in `tests/models.test.ts` pass (`6 pass, 0 fail`).

## Commit

*Only when the user asks.*

```text
feat(core): scaffold peer TypeScript+Bun package and Zod domain models
```

## Done-when

- [ ] `package.json` pins all dependencies without `^` or `~` and exposes `"bin": { "peer": "./src/cli.ts" }`.
- [ ] `Makefile` defines `check` running `bun run lint && bun run typecheck && bun test`.
- [ ] `src/models.ts` implements all Zod schemas, TypeScript types, and profile/hunk validation functions with strict typing.
- [ ] All 6 unit tests in `tests/models.test.ts` pass via `make check`.
