import { describe, expect, test } from "bun:test";

import {
  LensOutputParseError,
  parseLensFindingsOutput,
  parseLensFindingsWithWarnings,
  parseSkepticVerdicts,
  parseWalkthroughOutput,
} from "../src/llm/parser.ts";

describe("Structured Markdown & JSON lens output parser", () => {
  test("parseWalkthroughOutput parses structured Markdown walkthrough with triage, layered changes, and mermaid diagram", () => {
    const md = `## SUMMARY
Scopes the synchronous mutex lock before awaiting the raft proposal and removes dead retry shims.

## TRIAGE
- review_effort: 3
- merge_risk: High
- rationale: Modifies core consensus lock acquisition path.

## CHANGES
- [L0 | raftstore] \`components/raftstore/src/lib.rs\`: Drops mutex guard before async await.
- [L1 | server] src/server.rs: Calls raftstore step with propagated error.

## SEQUENCE_DIAGRAM
\`\`\`mermaid
sequenceDiagram
  participant S as "Server"
  participant R as "Raftstore"
  S->>R: step()
\`\`\`
`;

    const parsed = parseWalkthroughOutput(md);
    expect(parsed.summary).toContain("Scopes the synchronous mutex lock");
    expect(parsed.triage.reviewEffort).toBe(3);
    expect(parsed.triage.mergeRisk).toBe("High");
    expect(parsed.triage.rationale).toContain("core consensus lock");
    expect(parsed.changes).toEqual([
      {
        layer: 0,
        crateName: "raftstore",
        filePath: "components/raftstore/src/lib.rs",
        summary: "Drops mutex guard before async await.",
      },
      {
        layer: 1,
        crateName: "server",
        filePath: "src/server.rs",
        summary: "Calls raftstore step with propagated error.",
      },
    ]);
    expect(parsed.sequenceDiagram).toContain("sequenceDiagram");
    expect(parsed.sequenceDiagram).toContain("S->>R: step()");
  });

  test("parseLensFindingsOutput parses structured Markdown findings preserving exact Rust indentation in Suggestion fences", () => {
    const md = `## FINDINGS

### FINDING
- file: \`src/services/common/ledger.rs\`
- lines: 79-81
- severity: High
- type: Concurrency
- state: VERIFIED-DEFECT
- mechanism: Concurrency
- confidence: 0.96
- title: Panic in writer job kills single ledger thread
- root_cause: Unprotected job() execution on single-consumer channel loop
- blast_radius: All durable ledger writes across engine
- reversible: true
- depends_on: none
- verification: cargo test --lib services::common::ledger
- traceability: Violates line 107 error message contract

#### Explanation
Unwrapped \`job()\` panics unwind the writer loop and drop the receiver channel.
Contains "unescaped quotes" and \\backslashes\\ that would break JSON.

#### Suggestion
\`\`\`rust
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
    if result.is_err() {
        tracing::error!("ledger job panicked");
    }
\`\`\`

#### Agent Prompt
Wrap \`job()\` in \`catch_unwind\` at \`src/services/common/ledger.rs\` lines 79-81.

### FINDING
- file: src/oms/kernel.rs
- lines: 42
- severity: Minor
- type: Idioms
- title: Avoid redundant clone on order id

#### Explanation
\`order_id.clone()\` allocates on the hot path where \`&str\` suffices.

#### Suggestion
none

#### Agent Prompt
Pass \`&order_id\` by reference in \`src/oms/kernel.rs\` line 42.

## CONSIDERED_AND_REJECTED
- \`src/services/common/ledger.rs:459\` | Potential deadlock in enable_derivatives_mode | Does not hold outer OMS lock while calling run_sync.

## DELETIONS_PROPOSED
- \`fn unused_helper (src/old.rs:10)\` | 0 production callers in symbol graph | none — remove dead code

## OPEN_QUESTIONS
- \`src/exchange/dhan/mod.rs:44\` | [UNKNOWN] Expected max burst rate on WS reconnect | Backoff ceiling sizing
`;

    const parsed = parseLensFindingsOutput(md);
    expect(parsed.findings.length).toBe(2);

    const f0 = parsed.findings[0];
    expect(f0?.filePath).toBe("src/services/common/ledger.rs");
    expect(f0?.startLine).toBe(79);
    expect(f0?.endLine).toBe(81);
    // "High" alias normalized to "Major"
    expect(f0?.severity).toBe("Major");
    expect(f0?.type).toBe("Concurrency");
    expect(f0?.epistemicState).toBe("VERIFIED-DEFECT");
    expect(f0?.evidenceMechanism).toBe("Concurrency");
    expect(f0?.confidence).toBe(0.96);
    expect(f0?.body).toContain('Contains "unescaped quotes" and \\backslashes\\');
    // Leading 4-space indentation MUST be preserved verbatim for cargo check!
    expect(f0?.suggestion).toBe(
      [
        "    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));",
        "    if result.is_err() {",
        '        tracing::error!("ledger job panicked");',
        "    }",
      ].join("\n"),
    );

    const f1 = parsed.findings[1];
    expect(f1?.filePath).toBe("src/oms/kernel.rs");
    expect(f1?.startLine).toBe(42);
    expect(f1?.endLine).toBe(42);
    expect(f1?.suggestion).toBeNull();

    expect(parsed.consideredAndRejected).toEqual([
      {
        location: "src/services/common/ledger.rs:459",
        hypothesis: "Potential deadlock in enable_derivatives_mode",
        reasonDismissed: "Does not hold outer OMS lock while calling run_sync.",
      },
    ]);
    expect(parsed.deletionsProposed).toEqual([
      {
        pathOrSymbol: "fn unused_helper (src/old.rs:10)",
        reachabilityEvidence: "0 production callers in symbol graph",
        replacement: "none — remove dead code",
      },
    ]);
    expect(parsed.openQuestions).toEqual([
      {
        location: "src/exchange/dhan/mod.rs:44",
        question: "[UNKNOWN] Expected max burst rate on WS reconnect",
        impact: "Backoff ceiling sizing",
      },
    ]);
  });

  test("parseLensFindingsOutput recovers valid findings when one finding block is malformed and accepts clean zero-finding Markdown", () => {
    const partialMd = `## FINDINGS

### FINDING
- severity: Major
- title: Missing file and lines should be skipped cleanly

#### Explanation
Malformed finding with no location.

### FINDING
- file: src/lib.rs
- lines: 12-14
- severity: Critical
- type: Bug
- title: Valid finding survives

#### Explanation
Concrete bug on lines 12-14.
`;
    const partial = parseLensFindingsOutput(partialMd);
    expect(partial.findings.length).toBe(1);
    expect(partial.findings[0]?.title).toBe("Valid finding survives");

    const cleanMd = `## FINDINGS
None.

## CONSIDERED_AND_REJECTED
- \`src/lib.rs:10\` | Checked unwrap | Guarded by is_some() check above.
`;
    const clean = parseLensFindingsOutput(cleanMd);
    expect(clean.findings.length).toBe(0);
    expect(clean.consideredAndRejected.length).toBe(1);
  });

  test("parsers fall back seamlessly to JSON responses and throw LensOutputParseError on unstructured garbage", () => {
    const jsonFindings = JSON.stringify({
      findings: [
        {
          filePath: "src/lib.rs",
          startLine: 5,
          endLine: 5,
          severity: "Major",
          type: "Bug",
          title: "JSON fallback works",
          body: "Still supports JSON responses.",
          suggestion: null,
          agentPrompt: "Fix line 5.",
          confidence: 0.9,
        },
      ],
    });
    const parsedJson = parseLensFindingsOutput(jsonFindings);
    expect(parsedJson.findings.length).toBe(1);
    expect(parsedJson.findings[0]?.title).toBe("JSON fallback works");

    expect(() => parseLensFindingsOutput("not json and no markdown sections")).toThrow(
      LensOutputParseError,
    );
    expect(() => parseWalkthroughOutput("not json and no markdown sections")).toThrow(
      LensOutputParseError,
    );
    // When FINDING blocks exist but ALL fail to parse, throw LensOutputParseError instead of silently returning []
    expect(() =>
      parseLensFindingsOutput(
        `## FINDINGS\n\n### FINDING\n- severity: Major\n- title: Missing file and lines\n`,
      ),
    ).toThrow(LensOutputParseError);

    const verdicts = parseSkepticVerdicts(`## VERDICTS
- \`f-1\` | KEEP | Confirmed lock held across await on line 42
- \`f-2\` | DROP | Guarded by non-empty check on line 18
`);
    expect(verdicts.get("f-1")).toEqual({
      keep: true,
      reason: "Confirmed lock held across await on line 42",
    });
    expect(verdicts.get("f-2")).toEqual({
      keep: false,
      reason: "Guarded by non-empty check on line 18",
    });
  });

  test("preserves trailing inline code backticks in titles and fields while stripping wrapping backticks on paths", () => {
    const md = `## FINDINGS

### FINDING
- file: \`src/daemon.rs\`
- lines: 184-184
- severity: Minor
- type: Idioms
- title: Replace unused \`_px_dec\` binding with \`let _ = latest_price;\`

#### Explanation
Trailing inline code span must keep its closing backtick.
`;
    const parsed = parseLensFindingsOutput(md);
    expect(parsed.findings.length).toBe(1);
    expect(parsed.findings[0]?.filePath).toBe("src/daemon.rs");
    expect(parsed.findings[0]?.title).toBe(
      "Replace unused `_px_dec` binding with `let _ = latest_price;`",
    );
  });

  test("F-04: parseLensFindingsWithWarnings accepts severity aliases with 0 warnings and ignores ### FINDING inside code fences", () => {
    const md = `## FINDINGS

### FINDING
- file: src/lib.rs
- lines: 10-12
- severity: High
- type: Bug
- title: Real bug with alias severity

#### Explanation
Example markdown:
\`\`\`markdown
### FINDING
- file: fake.rs
\`\`\`
`;
    const { output, warnings } = parseLensFindingsWithWarnings(md);
    expect(warnings).toEqual([]);
    expect(output.findings.length).toBe(1);
    expect(output.findings[0]?.severity).toBe("Major");
  });
});
