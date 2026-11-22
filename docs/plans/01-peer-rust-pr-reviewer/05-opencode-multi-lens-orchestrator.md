# Task 05 — OpenCode Multi-Lens Orchestrator (`@opencode/client`)

## Goal

Implement the multi-lens review orchestrator in `src/lenses.ts` using `@opencode/client` (`2.3.2`: `OpenCode.make`) and `@opencode/client/service` (`Service.ensure`, `Service.headers`), following the pattern in [`docs/tmp/free-model.ts`](../../tmp/free-model.ts). Configure strictly read-only OpenCode sessions over the checked-out local Rust repository and run the three specialized lenses concurrently:
1. **Walkthrough & Architecture Lens** (`WalkthroughReportSchema`)
2. **Soundness, `unsafe` & Async/Concurrency Lens** (`LensFindingsOutputSchema`)
3. **Idioms, Performance & Logic Lens** (`LensFindingsOutputSchema`, encoding the PingCAP/TiKV `rust-conventions` checklist)

## Files touched

- `src/lenses.ts` (implement)
- `tests/lenses.test.ts` (create)

## Deliverable

`src/lenses.ts` providing:
- `parseModelSpec(spec?: string): { providerID: string; id: string }` resolving `--model` / `PEER_MODEL` / `MODEL` (defaulting to `{ providerID: "opencode", id: "hy4-flash-free" }`). Bare model IDs like `"hy4-flash-free"` or `"big-pickle"` map to `providerID: "opencode"`, while `"provider/model"` strings split on the first `"/"`.
- `READONLY_SESSION_PERMISSIONS`: permission rules passed to `client.session.create({ location: { directory: repoRoot }, model, permissions: READONLY_SESSION_PERMISSIONS })` that deny all mutation/shell/interactive actions (`* -> deny`, `*.env -> deny`) while allowing read-only codebase inspection (`read`, `grep`, `glob`).
- Context-package builder (`buildReviewContextPrompt(context: ReviewContext): string`) embedding the PR title/body, layer-ordered file list from `CrateGraph`, `L<num>:`-annotated unified diff hunks, and pre-collected `ClippyDiagnostic` records.
- Three specialized lens prompts instructing the model to inspect any needed repository files using read-only tools and return a single JSON object matching the target Zod schema:
  1. `WALKTHROUGH_LENS_PROMPT` — produces high-level summary, architectural layer table (using the crate-graph layers), a valid fenced `mermaid` `sequenceDiagram` whenever cross-component/async/API control flow changes (quoting node/participant labels with special characters and avoiding HTML tags), and the `TriageScore` (review effort `1..5` + merge risk).
  2. `SOUNDNESS_CONCURRENCY_LENS_PROMPT` — focuses strictly on `unsafe` blocks, missing or invalid `// SAFETY:` invariants, FFI/pointer aliasing, `Drop` / panic-safety invariants, `Send`/`Sync` bounds, `std::sync::Mutex`/`RwLock` guards held across `.await` points, `tokio::select!` branch cancellation safety, unbounded channels/backpressure, and non-test `unwrap()`/`panic!()` paths.
  3. `IDIOMS_LOGIC_LENS_PROMPT` — focuses on domain logic bugs, off-by-one/boundary errors, error handling and `?` propagation, needless allocations/clones on hot paths, and PingCAP/TiKV Rust conventions (`crate::` imports, `as_`/`into_`/`to_` conversion naming, constructor/struct visibility, `Result` hygiene).
- `extractJsonObject(rawText: string): unknown` capable of extracting a JSON object from either raw JSON output or a ```` ```json ... ``` ```` fenced block in the assistant message.
- `OpenCodeMultiLensOrchestrator.runAllLenses(context: ReviewContext): Promise<{ walkthrough: WalkthroughReport; findings: Finding[] }>` that:
  - Connects via `Service.ensure()` + `OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })` (or uses an injected session runner in tests).
  - Runs the three lens sessions concurrently via `Promise.all`, where each lens creates a session (`client.session.create`), sends the prompt (`client.session.prompt`), waits for completion (`client.experimental.session.wait`), lists assistant messages (`client.message.list({ sessionID, type: "assistant" })`), extracts and validates the JSON payload against its Zod schema, and always removes the session (`client.session.remove({ sessionID })`) in `finally`.

## Constraints honoured

- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.1, §3.4) — Separates Walkthrough orientation from specialized defect-discovery lenses and requires single-hunk drop-in `suggestion` blocks plus coding-agent fix briefs per finding.
- [`skills/rust-conventions/SKILL.md`](/home/skull/.gemini/config/plugins/agent-workflow/skills/rust-conventions/SKILL.md) — Encodes PingCAP/TiKV Rust style guide rules into the Idioms, Performance & Logic lens prompt, distinguishing hard defects (`Bug`/`Performance`, `Major`/`Critical`) from stylistic preferences (`Idioms`/`Refactor`, `Minor`/`Trivial`).
- [`rules/70-code-rationale.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/70-code-rationale.md) — Document why `READONLY_SESSION_PERMISSIONS` places `{ action: "*", resource: "*", effect: "deny" }` first and `{ action: "read", resource: "*.env*", effect: "deny" }` last (because OpenCode evaluates session permissions after agent defaults with last-matching-rule-wins semantics).

## Named tests (bodies omitted)

- `tests/lenses.test.ts::"parseModelSpec resolves default hy4-flash-free, bare opencode models, and provider/model pairs"` — Asserts that `parseModelSpec(undefined)` returns `{ providerID: "opencode", id: "hy4-flash-free" }`, `parseModelSpec("big-pickle")` returns `{ providerID: "opencode", id: "big-pickle" }`, and `parseModelSpec("anthropic/claude-sonnet-4-5")` returns `{ providerID: "anthropic", id: "claude-sonnet-4-5" }`.
- `tests/lenses.test.ts::"READONLY_SESSION_PERMISSIONS denies wildcard mutations and secrets while allowing read, grep, and glob"` — Verifies the exact rule ordering in `READONLY_SESSION_PERMISSIONS` under OpenCode's last-matching-rule-wins evaluator so `edit`, `write`, `shell`, `question`, and `*.env` reads resolve to `"deny"` while `read`, `grep`, and `glob` on source files resolve to `"allow"`.
- `tests/lenses.test.ts::"extractJsonObject parses both raw JSON and markdown-fenced JSON responses"` — Asserts extraction of valid JSON objects wrapped in prose and ```` ```json ```` fences, and throws a descriptive `LensOutputParseError` when no valid JSON object is present.
- `tests/lenses.test.ts::"OpenCodeMultiLensOrchestrator runs three lenses concurrently, validates Zod schemas, and removes sessions"` — Using a recording fake OpenCode client matching the `session.create` / `session.prompt` / `experimental.session.wait` / `message.list` / `session.remove` contract, asserts that all 3 lenses execute with `READONLY_SESSION_PERMISSIONS`, their assistant text blocks are validated into `WalkthroughReport` and `Finding[]`, and `session.remove` is called for all 3 sessions even when a lens throws.

## Code-only decisions

```ts
// Why: In @opencode/schema (session.d.ts), `SessionCreateInput.permissions` is
// evaluated after the agent's default rules (`* -> allow`) and the last matching
// rule wins. Starting with `{ action: "*", resource: "*", effect: "deny" }`
// revokes write, edit, shell, browser, and interactive question tools; allowing
// `read`, `grep`, and `glob` enables repository navigation; and trailing `deny`
// rules on `*.env` / `*.env.*` prevent secret reads without triggering an
// interactive `"ask"` prompt that would hang a non-interactive CLI session.
export const READONLY_SESSION_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
] as const;
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests` and `tsc --noEmit` pass with zero issues.
- `bun test` runs all tests including `tests/lenses.test.ts` with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(lenses): add OpenCode SDK read-only multi-lens review orchestrator
```

## Done-when

- [ ] `parseModelSpec` defaults to `{ providerID: "opencode", id: "hy4-flash-free" }` and supports `MODEL` / `PEER_MODEL` / `--model` overrides.
- [ ] `OpenCodeMultiLensOrchestrator` connects via `Service.ensure()` and `OpenCode.make(...)`, creates sessions with `READONLY_SESSION_PERMISSIONS`, awaits `client.experimental.session.wait`, extracts assistant replies from `client.message.list`, validates with Zod, and cleans up via `client.session.remove`.
- [ ] All three lens prompts (Walkthrough/Architecture, Soundness/`unsafe`/Concurrency, Idioms/Performance/Logic with PingCAP/TiKV rules) are implemented.
- [ ] All 4 tests in `tests/lenses.test.ts` pass via `make check`.
