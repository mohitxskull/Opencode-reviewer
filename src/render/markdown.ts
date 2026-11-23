import {
  type Finding,
  type FindingType,
  PEER_REVIEW_MARKER,
  type ReviewBundle,
  type Severity,
  WALKTHROUGH_MARKER,
} from "../domain/models.ts";
import { fillTemplate } from "../domain/template.ts";
import combinedReviewTemplate from "./templates/combined-review.md" with { type: "text" };
import inlineFindingTemplate from "./templates/inline-finding.md" with { type: "text" };
import reviewSummaryTemplate from "./templates/review-summary.md" with { type: "text" };
import walkthroughTemplate from "./templates/walkthrough.md" with { type: "text" };

const TYPE_EMOJI: Readonly<Record<FindingType, string>> = {
  Bug: "🐛",
  Security: "🔒",
  Soundness: "🛡️",
  Concurrency: "⚡",
  Performance: "🚀",
  Idioms: "🦀",
  Refactor: "🧹",
};

const SEVERITY_EMOJI: Readonly<Record<Severity, string>> = {
  Critical: "🔴",
  Major: "🟠",
  Minor: "🟡",
  Trivial: "🔵",
  Info: "ℹ️",
  None: "⚪",
};

function computeSafeFence(content: string): string {
  let maxRun = 2;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > maxRun) {
      maxRun = match[0].length;
    }
  }
  return "`".repeat(maxRun + 1);
}

const SHELL_COMMAND_IN_BACKTICKS_REGEX =
  /\b(?:cat|curl|wget|bash|sh|zsh|nc|ncat|python|python3|perl|ruby|node|bun|rm|chmod|chown|sudo|env|printenv|export|eval|exec|ssh|scp|base64|whoami|id|uname)\b|[;$|><&]|\/etc\/|\/proc\/|\/var\//i;

// Why: AI-generated "Prompt for Coding Agents" blocks posted to GitHub PR threads
// are consumed by downstream coding agents (such as autofix). Sanitizing shell
// execution directives, secret env var names, and non-GitHub URLs at render time
// enforces the untrusted-input defense-in-depth boundary.
export function sanitizeAgentPrompt(prompt: string): string {
  let sanitized = prompt;

  // Redact fenced code blocks containing shell commands
  sanitized = sanitized.replace(/```[^\n]*\n([\s\S]*?)```/g, (fullMatch, inner: string) => {
    if (SHELL_COMMAND_IN_BACKTICKS_REGEX.test(inner)) {
      return "[redacted-command-block]";
    }
    return fullMatch;
  });

  // Redact backtick code spans ONLY when they contain shell execution commands or path/pipe metacharacters,
  // preserving legitimate inline Rust code spans like `src/lib.rs` or `x.saturating_add(1)`.
  sanitized = sanitized.replace(/`([^`]*)`/g, (fullMatch, inner: string) => {
    if (SHELL_COMMAND_IN_BACKTICKS_REGEX.test(inner)) {
      return "[redacted-command]";
    }
    return fullMatch;
  });

  // Iteratively strip nested command substitutions $(...)
  let prev = "";
  while (prev !== sanitized && sanitized.includes("$(")) {
    prev = sanitized;
    sanitized = sanitized.replace(/\$\([^()]*\)/g, "[redacted-command]");
  }
  sanitized = sanitized.replace(/\$\(/g, "[redacted-command]");

  // Strip credential paths (~/.ssh, $HOME/.ssh, /home/.../.aws, ~/.gnupg, id_rsa, .env)
  sanitized = sanitized.replace(
    /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)\/\.(?:ssh|aws|gnupg|config|cargo\/credentials)\S*/gi,
    "[redacted-path]",
  );
  sanitized = sanitized.replace(/\b(?:id_rsa|id_ed25519)\b/gi, "[redacted-key]");
  sanitized = sanitized.replace(/(?:^|\s)\.[a-z0-9_.-]*env\b/gi, " [redacted-env]");

  // Strip secret environment variable names (any *TOKEN*, *SECRET*, *API_KEY*, *PRIVATE_KEY*, *PASSWORD*, *CREDENTIAL*)
  sanitized = sanitized.replace(
    /\$?\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PRIVATE_KEY|PASSWORD|CREDENTIAL)S?\b/g,
    "[redacted-secret]",
  );

  // Strip external non-GitHub URLs
  sanitized = sanitized.replace(/https?:\/\/[^\s)>\]"']+/gi, (match) => {
    try {
      const parsed = new URL(match);
      if (parsed.hostname.toLowerCase() === "github.com") {
        return match;
      }
    } catch {
      // Fall through to redaction
    }
    return "[redacted-url]";
  });

  // Neutralize closing HTML/Markdown container tags and Markdown images
  sanitized = sanitizeMarkdownText(sanitized);

  return sanitized.trim();
}

export function sanitizeMarkdownText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[redacted-image]")
    .replace(/<\/?(?:details|summary|blockquote|script|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "");
}

function escapeTableCell(value: string): string {
  return sanitizeMarkdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function renderGroupedCollapsibleSection(
  summaryTitle: string,
  findings: readonly Finding[],
  cautionPrefix?: string,
): string {
  if (findings.length === 0) {
    return "";
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.filePath) ?? [];
    list.push(f);
    byFile.set(f.filePath, list);
  }

  const lines: string[] = [];
  if (cautionPrefix) {
    lines.push(cautionPrefix, "");
  }
  lines.push("<details>", `<summary>${summaryTitle}</summary>`, "<blockquote>");

  for (const [filePath, fileFindings] of byFile.entries()) {
    lines.push(
      "",
      "<details>",
      `<summary><code>${sanitizeMarkdownText(filePath)}</code> (${fileFindings.length})</summary>`,
      "<blockquote>",
    );
    for (const f of fileFindings) {
      const rangeLabel =
        f.startLine === f.endLine ? `${f.startLine}` : `${f.startLine}-${f.endLine}`;
      lines.push(
        "",
        `\`${filePath}\` (${rangeLabel}):`,
        "",
        renderInlineFindingComment(f, { allowCommitSuggestion: false }),
        "",
        "---",
      );
    }
    lines.push("</blockquote>", "</details>");
  }

  lines.push("</blockquote>", "</details>");
  return lines.join("\n");
}

export function renderWalkthroughComment(bundle: ReviewBundle): string {
  const baseShort = bundle.diffBaseSha.slice(0, 7);
  const headShort = bundle.headSha.slice(0, 7);
  const modeLabel = bundle.isIncremental ? "Incremental Delta" : "Full PR Review";
  const { walkthrough } = bundle;
  const outside = bundle.outsideDiffFindings ?? [];
  const nitpicks = bundle.nitpickFindings ?? [];
  const allActionable = [...bundle.findings, ...outside];
  const totalFindingsCount = allActionable.length + nitpicks.length;

  const counts: Record<string, number> = {};
  for (const item of allActionable) {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .map(([sev, cnt]) => `${SEVERITY_EMOJI[sev as Severity] ?? ""} ${sev}: ${cnt}`)
    .join(" | ");

  const failedCohortsBanner =
    bundle.failedCohorts && bundle.failedCohorts.length > 0
      ? [
          `> [!WARNING]`,
          `> **Partial Review (${bundle.failedCohorts.length} cohort(s) failed):** ${bundle.failedCohorts.map((c) => `\`${sanitizeMarkdownText(c)}\``).join(", ")}. Re-run \`peer\` to complete coverage.`,
        ].join("\n")
      : "";

  const baselineSection = bundle.baseline
    ? [
        `### Review Baseline`,
        `- **Mode:** \`${bundle.baseline.mode}\` | **Commit Range:** \`${baseShort}..${headShort}\` | **Date:** \`${bundle.generatedAt}\``,
        `- **Toolchain:** \`${bundle.baseline.rustcVersion}\` | \`${bundle.baseline.cargoVersion}\``,
        `- **Verification Commands:** ${bundle.baseline.verificationCommands.map((c) => `\`${c}\``).join(" · ")}`,
      ].join("\n")
    : "";

  const rootCauseTable =
    allActionable.length > 0
      ? [
          `### 1. Root-Cause Index Table`,
          `| # | Severity | State | Mechanism | Confidence | Patch | Root Cause | Location | Blast Radius | Reversible? | Depends on |`,
          `| :---: | :--- | :--- | :--- | :---: | :---: | :--- | :--- | :--- | :---: | :--- |`,
          ...allActionable.map((f, i) => {
            const sevIcon = SEVERITY_EMOJI[f.severity];
            const confPct = `${Math.round(f.confidence * 100)}%`;
            const patchBadge =
              f.suggestion !== null && f.suggestionVerified
                ? "`✓ cargo check`"
                : f.suggestion !== null
                  ? "`unverified`"
                  : "—";
            const rootCauseText = escapeTableCell(f.rootCause || f.title);
            const locText = `\`${f.filePath}:${f.startLine}-${f.endLine}\``;
            const blastText = escapeTableCell(f.blastRadius || "Local module");
            const revText = f.reversible ? "Yes" : "No";
            const depText = escapeTableCell(f.dependsOn ?? "—");
            return `| \`F${i + 1}\` | ${sevIcon} ${f.severity} | \`${f.epistemicState ?? "VERIFIED-DEFECT"}\` | \`${f.evidenceMechanism ?? "Correctness"}\` | ${confPct} | ${patchBadge} | ${rootCauseText} | ${locText} | ${blastText} | ${revText} | ${depText} |`;
          }),
        ].join("\n")
      : "";

  const sortedChanges = [...walkthrough.changes].sort(
    (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );
  const changesRows = sortedChanges
    .map(
      (entry) =>
        `| \`L${entry.layer}\` | \`${entry.crateName}\` | \`${entry.filePath}\` | ${escapeTableCell(entry.summary)} |`,
    )
    .join("\n");

  let sequenceDiagramSection = "";
  if (walkthrough.sequenceDiagram && walkthrough.sequenceDiagram.trim().length > 0) {
    const rawDiagram = walkthrough.sequenceDiagram
      .trim()
      .replace(/^```(?:mermaid)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const fence = computeSafeFence(rawDiagram);
    sequenceDiagramSection = [`### Sequence Diagram`, `${fence}mermaid`, rawDiagram, fence].join(
      "\n",
    );
  }

  const deletions = bundle.deletionsProposed ?? [];
  const deletionsSection =
    deletions.length > 0
      ? [
          `### 3. Deletions Proposed`,
          `| Symbol / Path | Reachability Evidence | Replacement |`,
          `| :--- | :--- | :--- |`,
          ...deletions.map(
            (d) =>
              `| \`${escapeTableCell(d.pathOrSymbol)}\` | ${escapeTableCell(d.reachabilityEvidence)} | ${escapeTableCell(d.replacement)} |`,
          ),
        ].join("\n")
      : "";

  const rejected = bundle.consideredAndRejected ?? [];
  const consideredAndRejectedSection =
    rejected.length > 0
      ? [
          `<details>`,
          `<summary><strong>5. Considered & Rejected (${rejected.length})</strong> — Examined hypotheses dismissed with code evidence</summary>`,
          "",
          `| Location | Hypothesis Examined | Reason Dismissed |`,
          `| :--- | :--- | :--- |`,
          ...rejected.map(
            (r) =>
              `| \`${escapeTableCell(r.location)}\` | ${escapeTableCell(r.hypothesis)} | ${escapeTableCell(r.reasonDismissed)} |`,
          ),
          "",
          `</details>`,
        ].join("\n")
      : "";

  const openQuestions = bundle.openQuestions ?? [];
  const openQuestionsSection =
    openQuestions.length > 0
      ? [
          `### 6. Open Questions / Blockers`,
          `| Location | Question / Unverified Assumption | Impact |`,
          `| :--- | :--- | :--- |`,
          ...openQuestions.map(
            (q) =>
              `| \`${escapeTableCell(q.location)}\` | ${escapeTableCell(q.question)} | ${escapeTableCell(q.impact)} |`,
          ),
        ].join("\n")
      : "";

  const notReviewed = bundle.notReviewed ?? [];
  const notReviewedSection =
    notReviewed.length > 0
      ? [
          `<details>`,
          `<summary><strong>7. Not Reviewed (${notReviewed.length})</strong> — Non-code or out-of-scope paths</summary>`,
          "",
          ...notReviewed.map((item) => `- \`${item}\``),
          "",
          `</details>`,
        ].join("\n")
      : "";

  return fillTemplate(walkthroughTemplate, {
    WALKTHROUGH_MARKER,
    REVIEW_EFFORT: String(walkthrough.triage.reviewEffort),
    MERGE_RISK: walkthrough.triage.mergeRisk,
    PROFILE: bundle.profile,
    BASE_SHORT: baseShort,
    HEAD_SHORT: headShort,
    MODE_LABEL: modeLabel,
    TRIAGE_RATIONALE: sanitizeMarkdownText(walkthrough.triage.rationale).trim(),
    FAILED_COHORTS_BANNER: failedCohortsBanner,
    BASELINE_SECTION: baselineSection,
    SUMMARY: sanitizeMarkdownText(walkthrough.summary).trim(),
    TOTAL_FINDINGS_COUNT: String(totalFindingsCount),
    ACTIONABLE_COUNT: String(allActionable.length),
    BREAKDOWN_SUFFIX: breakdown ? ` — ${breakdown}` : "",
    NITPICK_COUNT: String(nitpicks.length),
    INLINE_COUNT: String(bundle.findings.length),
    OUTSIDE_COUNT: String(outside.length),
    CLIPPY_COUNT: String(bundle.clippyDiagnostics.length),
    SECURITY_ADVISORIES_COUNT: String(bundle.securityAdvisories?.length ?? 0),
    ROOT_CAUSE_TABLE: rootCauseTable,
    CHANGES_ROWS: changesRows,
    SEQUENCE_DIAGRAM_SECTION: sequenceDiagramSection,
    DELETIONS_SECTION: deletionsSection,
    CONSIDERED_AND_REJECTED_SECTION: consideredAndRejectedSection,
    OPEN_QUESTIONS_SECTION: openQuestionsSection,
    NOT_REVIEWED_SECTION: notReviewedSection,
  });
}

export interface RenderFindingOptions {
  readonly allowCommitSuggestion?: boolean;
}

export function renderInlineFindingComment(
  finding: Finding,
  options: RenderFindingOptions = {},
): string {
  const allowCommitSuggestion = options.allowCommitSuggestion ?? true;
  const metaBullets: string[] = [];
  if (finding.rootCause && finding.rootCause.trim().length > 0) {
    metaBullets.push(`- **Root Cause:** ${sanitizeMarkdownText(finding.rootCause).trim()}`);
  }
  if (finding.blastRadius && finding.blastRadius.trim().length > 0) {
    metaBullets.push(
      `- **Blast Radius:** ${sanitizeMarkdownText(finding.blastRadius).trim()} (Reversible: ${finding.reversible ? "Yes" : "No"})`,
    );
  }
  if (finding.traceability && finding.traceability.trim().length > 0) {
    metaBullets.push(`- **Traceability:** ${sanitizeMarkdownText(finding.traceability).trim()}`);
  }
  if (finding.verificationCommand && finding.verificationCommand.trim().length > 0) {
    metaBullets.push(
      `- **Verification:** \`${sanitizeMarkdownText(finding.verificationCommand).trim()}\``,
    );
  }

  let suggestionBlock = "";
  if (finding.suggestion !== null && finding.suggestion.trim().length > 0) {
    const cleanSuggestion = finding.suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const fence = computeSafeFence(cleanSuggestion);
    if (allowCommitSuggestion && finding.suggestionVerified) {
      suggestionBlock = [
        `> ✓ Verified with \`cargo check\``,
        `${fence}suggestion`,
        cleanSuggestion,
        fence,
      ].join("\n");
    } else if (!allowCommitSuggestion) {
      const note = finding.suggestionVerified
        ? `> ✓ Verified with \`cargo check\``
        : `> ℹ️ Candidate patch (not compiler-verified):`;
      suggestionBlock = [note, `${fence}rust`, cleanSuggestion, fence].join("\n");
    }
  }

  const lineRangeLabel =
    finding.startLine === finding.endLine
      ? `line ${finding.startLine}`
      : `lines ${finding.startLine}-${finding.endLine}`;

  const rendered = fillTemplate(inlineFindingTemplate, {
    TYPE_ICON: TYPE_EMOJI[finding.type],
    FINDING_TYPE: finding.type,
    SEV_ICON: SEVERITY_EMOJI[finding.severity],
    SEVERITY: finding.severity,
    STATE_LABEL: finding.epistemicState ?? "VERIFIED-DEFECT",
    MECHANISM_LABEL: finding.evidenceMechanism ?? "Correctness",
    TITLE: sanitizeMarkdownText(finding.title).trim(),
    BODY: sanitizeMarkdownText(finding.body).trim(),
    META_BULLETS: metaBullets.join("\n"),
    SUGGESTION_BLOCK: suggestionBlock,
    FILE_PATH: finding.filePath,
    LINE_RANGE_LABEL: lineRangeLabel,
    SAFE_PROMPT: sanitizeAgentPrompt(finding.agentPrompt),
  });
  return `<!-- peer:fp=${finding.id} -->\n${rendered}`;
}

export function renderPrReviewSummaryBody(bundle: ReviewBundle): string {
  const inlineCount = bundle.findings.length;
  const outside = bundle.outsideDiffFindings ?? [];
  const nitpicks = bundle.nitpickFindings ?? [];
  const actionableTotal = inlineCount + outside.length;
  const allActionable = [...bundle.findings, ...outside];

  const headerLine =
    `**Actionable comments posted: ${inlineCount}**` +
    (outside.length > 0 ? ` *(+${outside.length} outside diff range)*` : "") +
    (nitpicks.length > 0 ? ` | **Nitpicks: ${nitpicks.length}**` : "");

  const failedCohortsBanner =
    bundle.failedCohorts && bundle.failedCohorts.length > 0
      ? [
          `> [!WARNING]`,
          `> **Partial Review (${bundle.failedCohorts.length} cohort(s) failed):** ${bundle.failedCohorts.map((c) => `\`${sanitizeMarkdownText(c)}\``).join(", ")}.`,
        ].join("\n")
      : "";

  let severityBreakdownLine = "";
  if (allActionable.length > 0) {
    const crit = allActionable.filter((f) => f.severity === "Critical").length;
    const maj = allActionable.filter((f) => f.severity === "Major").length;
    const min = allActionable.filter((f) => f.severity === "Minor").length;
    const triv = allActionable.filter(
      (f) => f.severity === "Trivial" || f.severity === "Info",
    ).length;
    severityBreakdownLine = `> **Severity Breakdown (${actionableTotal} actionable):** 🔴 Critical: \`${crit}\` | 🟠 Major: \`${maj}\` | 🟡 Minor: \`${min}\`${triv > 0 ? ` | 🔵 Trivial/Info: \`${triv}\`` : ""}`;
  }

  const outsideDiffSection = renderGroupedCollapsibleSection(
    `⚠️ Outside diff range comments (${outside.length})`,
    outside,
    "> [!CAUTION]\n> Some comments are outside the diff and can't be posted inline due to GitHub limitations.",
  );

  const nitpickSection = renderGroupedCollapsibleSection(
    `🧹 Nitpick comments (${nitpicks.length})`,
    nitpicks,
  );

  return fillTemplate(reviewSummaryTemplate, {
    PEER_REVIEW_MARKER,
    HEADER_LINE: headerLine,
    FAILED_COHORTS_BANNER: failedCohortsBanner,
    SEVERITY_BREAKDOWN_LINE: severityBreakdownLine,
    OUTSIDE_DIFF_SECTION: outsideDiffSection,
    NITPICK_SECTION: nitpickSection,
  });
}

export function renderCombinedLocalReviewMarkdown(bundle: ReviewBundle): string {
  const inlineFindingsBody =
    bundle.findings.length === 0
      ? "No inline diff comments for the active review profile."
      : bundle.findings
          .map(
            (finding) =>
              `### \`${finding.filePath}:${finding.startLine}-${finding.endLine}\`\n\n${renderInlineFindingComment(finding)}`,
          )
          .join("\n\n");

  return fillTemplate(combinedReviewTemplate, {
    WALKTHROUGH_MD: renderWalkthroughComment(bundle),
    REVIEW_SUMMARY_MD: renderPrReviewSummaryBody(bundle),
    INLINE_COUNT: String(bundle.findings.length),
    INLINE_FINDINGS_BODY: inlineFindingsBody,
  });
}
