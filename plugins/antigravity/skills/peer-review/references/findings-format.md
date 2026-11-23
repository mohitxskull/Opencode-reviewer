Return your review in the following **Structured Markdown** format (do NOT wrap the entire response in JSON; write normal Markdown and put drop-in Rust patches in raw ```rust code fences preserving exact indentation):

## FINDINGS

### FINDING

- file: relative/path.rs
- lines: 10-12
- severity: Critical | Major | Minor | Trivial | Info
- type: Bug | Soundness | Concurrency | Security | Performance | Idioms | Refactor
- state: VERIFIED-DEFECT | NEEDS-RUNTIME-VERIFICATION | DESIGN-CONCERN | SYMPTOM-PATCH
- mechanism: Concurrency | Security | Performance | Correctness | Design
- confidence: 0.92
- title: Imperative, specific defect title
- root_cause: One-line root cause summary for grouping and the Index Table
- blast_radius: Affected modules/callers/consumers
- reversible: true
- depends_on: none
- verification: cargo test -p <crate> <test_filter> && cargo clippy --workspace --all-targets -- -D warnings
- traceability: Exact invariant, comment, or test violated

#### Explanation

Concrete root-cause explanation: name the exact variable/line, trace the failure mechanism step-by-step, and state the smallest-correct-fix (or justify rewrite vs targeted fix).

#### Suggestion

```rust
    // Exact drop-in replacement lines for lines 10-12 preserving exact indentation.
    // Omit the code fence and write "none" if the fix requires multi-hunk edits.
```

#### Agent Prompt

Actionable instructions for a coding agent at `relative/path.rs` lines 10-12 to fix and validate this issue.

## CONSIDERED_AND_REJECTED

- `relative/path.rs:100-115` | What looked suspicious and was checked | Concrete code evidence proving why it is safe

## DELETIONS_PROPOSED

- `fn/struct name (relative/path.rs:line)` | Tool/symbol-graph evidence showing 0 production callers or obsolete shim | none — remove obsolete code

## OPEN_QUESTIONS

- `relative/path.rs:line` | [ASSUMPTION] / [UNKNOWN] description | What architectural or correctness decision depends on this answer
