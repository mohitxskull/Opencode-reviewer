import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolvePeerReviewsDir } from "../git.ts";
import {
  type Finding,
  type FindingType,
  PEER_REVIEW_MARKER,
  type ReviewBundle,
  type Severity,
  WALKTHROUGH_MARKER,
} from "../models.ts";

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

// Why: AI-generated "Prompt for Coding Agents" blocks posted to GitHub PR threads
// are consumed by downstream coding agents (such as autofix). Sanitizing shell
// execution directives, secret env var names, and non-GitHub URLs at render time
// enforces the untrusted-input defense-in-depth boundary documented in
// docs/reports/research/coderabbit/2026-11-22-coderabbit-review-architecture.md §3.1.2.
export function sanitizeAgentPrompt(prompt: string): string {
  let sanitized = prompt;

  // Strip backtick shell execution (`...`)
  sanitized = sanitized.replace(/`[^`]*`/g, "[redacted-command]");

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

  // Neutralize closing HTML/Markdown container tags
  sanitized = sanitizeMarkdownText(sanitized);

  return sanitized.trim();
}

export function sanitizeMarkdownText(text: string): string {
  return text
    .replace(/<\/?(?:details|summary|blockquote|script|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "");
}

function escapeTableCell(value: string): string {
  return sanitizeMarkdownText(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
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

  const bySeverity = (items: readonly Finding[]) => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      counts[item.severity] = (counts[item.severity] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([sev, cnt]) => `${SEVERITY_EMOJI[sev as Severity] ?? ""} ${sev}: ${cnt}`)
      .join(" | ");
  };

  const breakdown = bySeverity(allActionable);

  const lines: string[] = [
    WALKTHROUGH_MARKER,
    `## 🦀 Peer Rust PR Walkthrough & Architecture Audit`,
    "",
    `**Review Effort:** \`${walkthrough.triage.reviewEffort}/5\` | **Merge Risk:** \`${walkthrough.triage.mergeRisk}\` | **Profile:** \`${bundle.profile}\` | **Range:** \`${baseShort}..${headShort}\` (${modeLabel})`,
    `> **Triage Rationale:** ${walkthrough.triage.rationale}`,
    "",
  ];

  if (bundle.baseline) {
    lines.push(
      `### Review Baseline`,
      `- **Mode:** \`${bundle.baseline.mode}\` | **Commit Range:** \`${baseShort}..${headShort}\` | **Date:** \`${bundle.generatedAt}\``,
      `- **Toolchain:** \`${bundle.baseline.rustcVersion}\` | \`${bundle.baseline.cargoVersion}\``,
      `- **Verification Commands:** ${bundle.baseline.verificationCommands.map((c) => `\`${c}\``).join(" · ")}`,
      "",
    );
  }

  lines.push(
    `### 0. Executive Summary`,
    sanitizeMarkdownText(walkthrough.summary).trim(),
    "",
    `- **Total Findings:** ${totalFindingsCount} (${breakdown || "0 actionable"})`,
    `- **Actionable Inline Comments:** ${bundle.findings.length}`,
    `- **Outside Diff Range Comments:** ${outside.length}`,
    `- **Nitpick Comments:** ${nitpicks.length}`,
    `- **Cargo Clippy / Compiler Diagnostics Checked:** ${bundle.clippyDiagnostics.length}`,
    "",
  );

  if (allActionable.length > 0) {
    lines.push(
      `### 1. Root-Cause Index Table`,
      `| # | Severity | State | Mechanism | Confidence | Root Cause | Location | Blast Radius | Reversible? | Depends on |`,
      `| :---: | :--- | :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |`,
    );
    for (let i = 0; i < allActionable.length; i++) {
      const f = allActionable[i];
      if (!f) {
        continue;
      }
      const sevIcon = SEVERITY_EMOJI[f.severity];
      const confPct = `${Math.round(f.confidence * 100)}%`;
      const rootCauseText = escapeTableCell(f.rootCause || f.title);
      const locText = `\`${f.filePath}:${f.startLine}-${f.endLine}\``;
      const blastText = escapeTableCell(f.blastRadius || "Local module");
      const revText = f.reversible ? "Yes" : "No";
      const depText = escapeTableCell(f.dependsOn ?? "—");
      lines.push(
        `| \`F${i + 1}\` | ${sevIcon} ${f.severity} | \`${f.epistemicState}\` | \`${f.evidenceMechanism}\` | ${confPct} | ${rootCauseText} | ${locText} | ${blastText} | ${revText} | ${depText} |`,
      );
    }
    lines.push("");
  }

  const sortedChanges = [...walkthrough.changes].sort(
    (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );

  lines.push(
    `### Architectural Layer Walkthrough`,
    `| Layer | Crate | File | Summary |`,
    `| :---: | :--- | :--- | :--- |`,
  );

  for (const entry of sortedChanges) {
    const safeSummary = escapeTableCell(entry.summary);
    lines.push(
      `| \`L${entry.layer}\` | \`${entry.crateName}\` | \`${entry.filePath}\` | ${safeSummary} |`,
    );
  }
  lines.push("");

  if (walkthrough.sequenceDiagram && walkthrough.sequenceDiagram.trim().length > 0) {
    const rawDiagram = walkthrough.sequenceDiagram
      .trim()
      .replace(/^```(?:mermaid)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    lines.push(`### Sequence Diagram`, "```mermaid", rawDiagram, "```", "");
  }

  const deletions = bundle.deletionsProposed ?? [];
  if (deletions.length > 0) {
    lines.push(
      `### 3. Deletions Proposed`,
      `| Symbol / Path | Reachability Evidence | Replacement |`,
      `| :--- | :--- | :--- |`,
    );
    for (const d of deletions) {
      lines.push(
        `| \`${escapeTableCell(d.pathOrSymbol)}\` | ${escapeTableCell(d.reachabilityEvidence)} | ${escapeTableCell(d.replacement)} |`,
      );
    }
    lines.push("");
  }

  const rejected = bundle.consideredAndRejected ?? [];
  if (rejected.length > 0) {
    lines.push(
      `<details>`,
      `<summary><strong>5. Considered & Rejected (${rejected.length})</strong> — Examined hypotheses dismissed with code evidence</summary>`,
      "",
      `| Location | Hypothesis Examined | Reason Dismissed |`,
      `| :--- | :--- | :--- |`,
    );
    for (const r of rejected) {
      lines.push(
        `| \`${escapeTableCell(r.location)}\` | ${escapeTableCell(r.hypothesis)} | ${escapeTableCell(r.reasonDismissed)} |`,
      );
    }
    lines.push("", `</details>`, "");
  }

  const openQuestions = bundle.openQuestions ?? [];
  if (openQuestions.length > 0) {
    lines.push(
      `### 6. Open Questions / Blockers`,
      `| Location | Question / Unverified Assumption | Impact |`,
      `| :--- | :--- | :--- |`,
    );
    for (const q of openQuestions) {
      lines.push(
        `| \`${escapeTableCell(q.location)}\` | ${escapeTableCell(q.question)} | ${escapeTableCell(q.impact)} |`,
      );
    }
    lines.push("");
  }

  const notReviewed = bundle.notReviewed ?? [];
  if (notReviewed.length > 0) {
    lines.push(
      `<details>`,
      `<summary><strong>7. Not Reviewed (${notReviewed.length})</strong> — Non-code or out-of-scope paths</summary>`,
      "",
      ...notReviewed.map((item) => `- \`${item}\``),
      "",
      `</details>`,
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

export interface RenderFindingOptions {
  readonly allowCommitSuggestion?: boolean;
}

export function renderInlineFindingComment(
  finding: Finding,
  options: RenderFindingOptions = {},
): string {
  const allowCommitSuggestion = options.allowCommitSuggestion ?? true;
  const typeIcon = TYPE_EMOJI[finding.type];
  const sevIcon = SEVERITY_EMOJI[finding.severity];
  const stateLabel = finding.epistemicState ?? "VERIFIED-DEFECT";
  const mechanismLabel = finding.evidenceMechanism ?? "Correctness";
  const safeTitle = sanitizeMarkdownText(finding.title).trim();
  const safeBody = sanitizeMarkdownText(finding.body).trim();

  const lines: string[] = [
    `_${typeIcon} ${finding.type}_ | _${sevIcon} ${finding.severity}_ | \`${stateLabel}\` | **Mechanism:** \`${mechanismLabel}\``,
    "",
    `**${safeTitle}**`,
    "",
    safeBody,
  ];

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
  if (metaBullets.length > 0) {
    lines.push("", ...metaBullets);
  }

  if (finding.suggestion !== null && finding.suggestion.trim().length > 0) {
    const cleanSuggestion = finding.suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "");
    if (allowCommitSuggestion && finding.suggestionVerified) {
      lines.push("", `> ✓ Verified with \`cargo check\``, "```suggestion", cleanSuggestion, "```");
    } else if (!allowCommitSuggestion) {
      lines.push("", "```rust", cleanSuggestion, "```");
    }
  }

  const safePrompt = sanitizeAgentPrompt(finding.agentPrompt);
  const lineRangeLabel =
    finding.startLine === finding.endLine
      ? `line ${finding.startLine}`
      : `lines ${finding.startLine}-${finding.endLine}`;

  lines.push(
    "",
    `<details><summary>Prompt for Coding Agents</summary>`,
    "",
    `In \`${finding.filePath}\` (${lineRangeLabel}):`,
    safePrompt,
    "",
    `</details>`,
  );

  return lines.join("\n");
}

export function renderPrReviewSummaryBody(bundle: ReviewBundle): string {
  const inlineCount = bundle.findings.length;
  const outside = bundle.outsideDiffFindings ?? [];
  const nitpicks = bundle.nitpickFindings ?? [];
  const actionableTotal = inlineCount + outside.length;

  const lines: string[] = [
    PEER_REVIEW_MARKER,
    `**Actionable comments posted: ${inlineCount}**` +
      (outside.length > 0 ? ` *(+${outside.length} outside diff range)*` : "") +
      (nitpicks.length > 0 ? ` | **Nitpicks: ${nitpicks.length}**` : ""),
  ];

  const allActionable = [...bundle.findings, ...outside];
  if (allActionable.length > 0) {
    const crit = allActionable.filter((f) => f.severity === "Critical").length;
    const maj = allActionable.filter((f) => f.severity === "Major").length;
    const min = allActionable.filter((f) => f.severity === "Minor").length;
    const triv = allActionable.filter(
      (f) => f.severity === "Trivial" || f.severity === "Info",
    ).length;
    lines.push(
      `> **Severity Breakdown (${actionableTotal} actionable):** 🔴 Critical: \`${crit}\` | 🟠 Major: \`${maj}\` | 🟡 Minor: \`${min}\`${triv > 0 ? ` | 🔵 Trivial/Info: \`${triv}\`` : ""}`,
    );
  }

  if (outside.length > 0) {
    const byFile = new Map<string, Finding[]>();
    for (const f of outside) {
      const list = byFile.get(f.filePath) ?? [];
      list.push(f);
      byFile.set(f.filePath, list);
    }

    lines.push(
      "",
      "> [!CAUTION]",
      "> Some comments are outside the diff and can't be posted inline due to GitHub limitations.",
      "",
      "<details>",
      `<summary>⚠️ Outside diff range comments (${outside.length})</summary>`,
      "<blockquote>",
    );

    for (const [filePath, fileFindings] of byFile.entries()) {
      lines.push(
        "",
        "<details>",
        `<summary><code>${filePath}</code> (${fileFindings.length})</summary>`,
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
  }

  if (nitpicks.length > 0) {
    const byFile = new Map<string, Finding[]>();
    for (const f of nitpicks) {
      const list = byFile.get(f.filePath) ?? [];
      list.push(f);
      byFile.set(f.filePath, list);
    }

    lines.push(
      "",
      "<details>",
      `<summary>🧹 Nitpick comments (${nitpicks.length})</summary>`,
      "<blockquote>",
    );

    for (const [filePath, fileFindings] of byFile.entries()) {
      lines.push(
        "",
        "<details>",
        `<summary><code>${filePath}</code> (${fileFindings.length})</summary>`,
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
  }

  return lines.join("\n");
}

export function renderCombinedLocalReviewMarkdown(bundle: ReviewBundle): string {
  const sections: string[] = [
    renderWalkthroughComment(bundle),
    "",
    "---",
    "",
    "## PR Review Summary & Collapsible Sections",
    "",
    renderPrReviewSummaryBody(bundle),
    "",
    "---",
    "",
    `## 2. Actionable Inline Diff Findings (${bundle.findings.length})`,
  ];

  if (bundle.findings.length === 0) {
    sections.push("", "No inline diff comments for the active review profile.");
  } else {
    for (const finding of bundle.findings) {
      sections.push(
        "",
        `### \`${finding.filePath}:${finding.startLine}-${finding.endLine}\``,
        "",
        renderInlineFindingComment(finding),
      );
    }
  }

  return sections.join("\n");
}

export async function writeLocalReviewArtifacts(
  repoRoot: string,
  bundle: ReviewBundle,
): Promise<string> {
  const artifactDir = resolvePeerReviewsDir(repoRoot, bundle.pr.number);
  await mkdir(artifactDir, { recursive: true });

  const walkthroughMd = renderWalkthroughComment(bundle);
  const reviewMd = renderCombinedLocalReviewMarkdown(bundle);
  const findingsJson = JSON.stringify(
    {
      baseline: bundle.baseline,
      inlineFindings: bundle.findings,
      outsideDiffFindings: bundle.outsideDiffFindings ?? [],
      nitpickFindings: bundle.nitpickFindings ?? [],
      consideredAndRejected: bundle.consideredAndRejected ?? [],
      deletionsProposed: bundle.deletionsProposed ?? [],
      openQuestions: bundle.openQuestions ?? [],
      notReviewed: bundle.notReviewed ?? [],
    },
    null,
    2,
  );

  await Promise.all([
    Bun.write(join(artifactDir, "walkthrough.md"), walkthroughMd),
    Bun.write(join(artifactDir, "review.md"), reviewMd),
    Bun.write(join(artifactDir, "findings.json"), findingsJson),
  ]);

  return artifactDir;
}
