# Task 07 — Renderers and CLI Entrypoint

## Goal

Implement the CodeRabbit-grade Markdown renderers (`src/render/markdown.ts`), the ANSI terminal report renderer (`src/render/terminal.ts`), the local artifact writer under `.git/peer/reviews/pr-<number>/`, and the Bun CLI entrypoint (`src/cli.ts`, invoked as `peer` or `peer review [PR_TARGET]`) wiring the full end-to-end review pipeline together.

## Files touched

- `src/render/markdown.ts` (implement)
- `src/render/terminal.ts` (implement)
- `src/cli.ts` (implement)
- `tests/render.test.ts` (create)
- `tests/cli.test.ts` (create)

## Deliverable

1. `src/render/markdown.ts`:
   - `renderWalkthroughComment(bundle: ReviewBundle): string` producing the top-level GitHub PR Walkthrough comment starting with `<!-- peer-walkthrough-comment -->`, triage badges (`Review Effort: <1-5>/5`, `Merge Risk: <Risk>`, commit range `<baseShort>..<headShort>`), high-level architectural walkthrough, layer-ordered table of changes (`| Layer | Crate / File | Summary |`), and optional fenced `mermaid` `sequenceDiagram`.
   - `renderInlineFindingComment(finding: Finding): string` producing the CodeRabbit-compatible inline thread comment:
     - Structured badge header: `_<Type Emoji> <Type>_ | _<Severity Emoji> <Severity>_` (e.g., `_🐛 Bug_ | _🔴 Critical_`).
     - Concise root-cause explanation and rationale.
     - Compiler-verified ```` ```suggestion ```` block (included only when `finding.suggestion !== null && finding.suggestionVerified === true`, annotated with a `✓ Verified with cargo check` note).
     - Collapsible `<details><summary>Prompt for Coding Agents</summary>...</details>` block containing file path, line range, and sanitized diagnostic instructions.
   - `sanitizeAgentPrompt(prompt: string): string` stripping dangerous shell-execution directives, backtick command substitutions, credential path references (`~/.ssh`, `.env`, `GITHUB_TOKEN`, `PEER_GITHUB_TOKEN`), and external non-GitHub URLs per the untrusted-input boundary in [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.1.2).
   - `writeLocalReviewArtifacts(repoRoot: string, bundle: ReviewBundle): Promise<string>` writing `walkthrough.md`, `findings.json`, and `review.md` to `<repoRoot>/.git/peer/reviews/pr-<num>/`.
2. `src/render/terminal.ts`:
   - `formatTerminalReport(bundle: ReviewBundle, artifactDir: string): string` rendering the walkthrough summary box, architectural layer table, severity breakdown, clickable file/line-linked findings (`file:///abs/path#L<start>-L<end>`), and artifact paths.
3. `src/cli.ts`:
   - CLI argument parser (`util.parseArgs`) and end-to-end runner (`runCli(argv: string[], deps?: CliDependencies): Promise<number>`) supporting `peer` and `peer review [PR_TARGET]` with options:
     - `--repo <path>` (defaults to `process.cwd()`)
     - `--profile <quiet|chill|assertive>` (defaults to `"chill"`)
     - `--fresh` (defaults to `false`, forcing full `base..head` review when `true`)
     - `--local-only` (writes local artifacts and prints terminal report without posting to GitHub)
     - `--post` (posts/updates the top-level Walkthrough comment and creates a `PENDING` draft review on GitHub without interactive prompt)
     - `--submit-review` (when combined with `--post`, submits the inline review immediately with `event: "COMMENT"` instead of leaving it as a `PENDING` draft)
     - `--model <provider/model|model>` (optional model override for `@opencode/client`, defaulting to `process.env.PEER_MODEL ?? process.env.MODEL ?? "hy4-flash-free"`)
   - Interactive PR selector when `PR_TARGET` is omitted (lists open PRs from `GitHubClient.listOpenPrs` and prompts the developer to pick one).

## Constraints honoured

- [`docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md`](../../reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md) (§3.1, §3.4) — Emits exact `_Type_ | _Severity_` headers, verified ```` ```suggestion ```` blocks, sanitized `<details><summary>Prompt for Coding Agents</summary>` blocks, top-level Walkthrough with layer table + Mermaid diagram + effort/risk score, and local `file:///abs/path#L10-L20` links in terminal/local output.
- [`rules/40-verification.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/40-verification.md) & [`rules/testing.md`](/home/skull/.gemini/config/plugins/agent-workflow/rules/testing.md) — `tests/cli.test.ts` exercises the end-to-end CLI pipeline against a real temporary Rust git repository on disk, with a mock `fetch` injected into `@octokit/rest` and a deterministic fake lens runner, verifying checkout restoration, Clippy + `cargo check` suggestion verification, `.git/peer/reviews/pr-<num>/` artifact writing, and GitHub comment/pending-review payloads.

## Named tests (bodies omitted)

- `tests/render.test.ts::"renderWalkthroughComment includes marker, layer table, mermaid diagram, and triage badges"` — Asserts that `renderWalkthroughComment` begins with `<!-- peer-walkthrough-comment -->`, renders the architectural layer table in layer order, embeds the fenced `mermaid` `sequenceDiagram`, and displays review effort and merge risk badges.
- `tests/render.test.ts::"renderInlineFindingComment includes verified suggestion and omits unverified suggestion"` — Asserts that a finding with `suggestionVerified: true` renders a ```` ```suggestion ```` block, whereas a finding with `suggestionVerified: false` or `suggestion: null` never renders a ```` ```suggestion ```` fence while still rendering `_<Type>_ | _<Severity>_` and `<details><summary>Prompt for Coding Agents</summary>`.
- `tests/render.test.ts::"sanitizeAgentPrompt strips credential paths, secret env vars, and external URLs"` — Asserts that `sanitizeAgentPrompt` redacts credential paths (`~/.ssh/id_rsa`, `.env`, `PEER_GITHUB_TOKEN`), external non-GitHub URLs, and shell execution injections while keeping legitimate Rust diagnostic instructions intact.
- `tests/cli.test.ts::"runCli reviews Rust PR end-to-end, verifies suggestions with cargo check, writes artifacts, and posts PENDING review"` — Against a real temporary Rust git repo with one non-compiling suggestion candidate and one valid compiling suggestion candidate, runs `runCli(["review", "42", "--post", "--repo", tmpRepo], ...)` and asserts:
  1. The PR head commit is checked out during review and the original branch is restored on exit;
  2. The valid suggestion passes `cargo check` and is included in the GitHub `PENDING` review payload, while the non-compiling suggestion is stripped;
  3. `.git/peer/reviews/pr-42/walkthrough.md`, `findings.json`, `review.md`, and `checkpoint.json` exist on disk and `git status --porcelain` is completely clean.
- `tests/cli.test.ts::"runCli refuses dirty working tree before network or checkout"` — Modifies a tracked Rust file in the temporary repository, runs `runCli(["review", "42", "--local-only", "--repo", tmpRepo])`, and asserts a non-zero exit code with an error message naming the dirty file and zero GitHub requests or branch changes.

## Code-only decisions

```ts
// Why: AI-generated "Prompt for Coding Agents" blocks posted to GitHub PR threads
// are consumed by downstream coding agents (such as autofix). Sanitizing shell
// execution directives, secret env var names, and non-GitHub URLs at render time
// enforces the untrusted-input defense-in-depth boundary documented in
// docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md §3.1.2.
```

## Verification

```bash
cd /home/skull/Projects/peer && make check
```

Expected output:
- `biome check src tests`: passes with 0 errors/warnings.
- `tsc --noEmit`: exits `0` with no errors.
- `bun test`: full test suite across `tests/models.test.ts`, `tests/git.test.ts`, `tests/github.test.ts`, `tests/diff.test.ts`, `tests/rust.test.ts`, `tests/lenses.test.ts`, `tests/judge.test.ts`, `tests/verifier.test.ts`, `tests/render.test.ts`, and `tests/cli.test.ts` passes with 0 failures.

## Commit

*Only when the user asks.*

```text
feat(cli,render): add CodeRabbit-grade markdown/terminal renderers and peer Bun CLI
```

## Done-when

- [ ] `renderWalkthroughComment` and `renderInlineFindingComment` emit CodeRabbit-grade markdown with verified ```` ```suggestion ```` blocks and sanitized `Prompt for Coding Agents` sections.
- [ ] `writeLocalReviewArtifacts` writes `walkthrough.md`, `findings.json`, and `review.md` to `.git/peer/reviews/pr-<num>/`.
- [ ] `peer` / `peer review` CLI runs the full end-to-end pipeline, restores the original git branch, and supports `--local-only`, `--post`, `--submit-review`, `--fresh`, `--model`, and `--profile`.
- [ ] Full `make check` gate passes with zero warnings and 0 test failures.
