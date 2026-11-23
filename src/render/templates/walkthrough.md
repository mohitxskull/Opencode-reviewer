{{WALKTHROUGH_MARKER}}

## 🦀 Peer Rust PR Walkthrough & Architecture Audit

**Review Effort:** `{{REVIEW_EFFORT}}/5` | **Merge Risk:** `{{MERGE_RISK}}` | **Profile:** `{{PROFILE}}` | **Range:** `{{BASE_SHORT}}..{{HEAD_SHORT}}` ({{MODE_LABEL}})

> **Triage Rationale:** {{TRIAGE_RATIONALE}}

{{FAILED_COHORTS_BANNER}}

{{BASELINE_SECTION}}

### 0. Executive Summary

{{SUMMARY}}

- **Substantive Review Findings (LLM + Core Compiler/AST/CVE):** {{CORE_REVIEW_COUNT}}{{CORE_BREAKDOWN_SUFFIX}}
- **Optional Analyzer Diagnostics (coverage / semver / geiger / deny / miri):** {{OPTIONAL_TOOL_COUNT}}
- **Total Findings:** {{TOTAL_FINDINGS_COUNT}} (Actionable: {{ACTIONABLE_COUNT}}{{BREAKDOWN_SUFFIX}} | Nitpicks: {{NITPICK_COUNT}})
- **Actionable Inline Comments:** {{INLINE_COUNT}}
- **Outside Diff Range Comments:** {{OUTSIDE_COUNT}}
- **Nitpick Comments:** {{NITPICK_COUNT}}
- **Cargo Clippy / Compiler Diagnostics Checked:** {{CLIPPY_COUNT}}
- **CVE / RustSec Advisories Found:** {{SECURITY_ADVISORIES_COUNT}}

{{ROOT_CAUSE_TABLE}}

### Architectural Layer Walkthrough

| Layer | Crate | File | Summary |
| :---: | :---- | :--- | :------ |
{{CHANGES_ROWS}}

{{SEQUENCE_DIAGRAM_SECTION}}

{{DELETIONS_SECTION}}

{{CONSIDERED_AND_REJECTED_SECTION}}

{{OPEN_QUESTIONS_SECTION}}

{{NOT_REVIEWED_SECTION}}
