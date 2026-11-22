import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PEER_GIT_REVIEWS_REL_PATH } from "../git.ts";
import {
  type Finding,
  type FindingType,
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

  // Strip command substitutions $(...)
  sanitized = sanitized.replace(/\$\([^)]*\)/g, "[redacted-command]");

  // Strip credential paths (~/.ssh, ~/.aws, ~/.gnupg, id_rsa, .env)
  sanitized = sanitized.replace(/~\/?\.(?:ssh|aws|gnupg|config)\S*/gi, "[redacted-path]");
  sanitized = sanitized.replace(/\bid_rsa\b|\bid_ed25519\b/gi, "[redacted-key]");
  sanitized = sanitized.replace(/(?:^|\s)\.[a-z0-9_.-]*env\b/gi, " [redacted-env]");

  // Strip secret environment variable names
  sanitized = sanitized.replace(
    /\$?\b(?:PEER_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/gi,
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

  // Neutralize closing </details> tag injection
  sanitized = sanitized.replace(/<\/details>/gi, "");

  return sanitized.trim();
}

export function renderWalkthroughComment(bundle: ReviewBundle): string {
  const baseShort = bundle.diffBaseSha.slice(0, 7);
  const headShort = bundle.headSha.slice(0, 7);
  const modeLabel = bundle.isIncremental ? "Incremental Delta" : "Full PR Review";
  const { walkthrough } = bundle;

  const lines: string[] = [
    WALKTHROUGH_MARKER,
    `## 🦀 Peer Rust PR Walkthrough`,
    "",
    `**Review Effort:** \`${walkthrough.triage.reviewEffort}/5\` | **Merge Risk:** \`${walkthrough.triage.mergeRisk}\` | **Profile:** \`${bundle.profile}\` | **Range:** \`${baseShort}..${headShort}\` (${modeLabel})`,
    `> **Triage Rationale:** ${walkthrough.triage.rationale}`,
    "",
    `### Summary`,
    walkthrough.summary.trim(),
    "",
  ];

  const sortedChanges = [...walkthrough.changes].sort(
    (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );

  lines.push(
    `### Architectural Layer Walkthrough`,
    `| Layer | Crate | File | Summary |`,
    `| :---: | :--- | :--- | :--- |`,
  );

  for (const entry of sortedChanges) {
    const safeSummary = entry.summary.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
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

  lines.push(
    `### Findings Summary`,
    `- **Actionable Inline Findings:** ${bundle.findings.length}`,
    `- **Cargo Clippy / Compiler Diagnostics Checked:** ${bundle.clippyDiagnostics.length}`,
  );

  return lines.join("\n");
}

export function renderInlineFindingComment(finding: Finding): string {
  const typeIcon = TYPE_EMOJI[finding.type];
  const sevIcon = SEVERITY_EMOJI[finding.severity];

  const lines: string[] = [
    `_${typeIcon} ${finding.type}_ | _${sevIcon} ${finding.severity}_`,
    "",
    `**${finding.title}**`,
    "",
    finding.body.trim(),
  ];

  if (finding.suggestion !== null && finding.suggestionVerified) {
    const cleanSuggestion = finding.suggestion.replace(/\r\n/g, "\n").replace(/\n$/, "");
    lines.push("", `> ✓ Verified with \`cargo check\``, "```suggestion", cleanSuggestion, "```");
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

export function renderCombinedLocalReviewMarkdown(bundle: ReviewBundle): string {
  const sections: string[] = [
    renderWalkthroughComment(bundle),
    "",
    "---",
    "",
    "## Inline Findings",
  ];

  if (bundle.findings.length === 0) {
    sections.push("", "No actionable findings for the active review profile.");
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
  const artifactDir = join(repoRoot, PEER_GIT_REVIEWS_REL_PATH, `pr-${bundle.pr.number}`);
  await mkdir(artifactDir, { recursive: true });

  const walkthroughMd = renderWalkthroughComment(bundle);
  const reviewMd = renderCombinedLocalReviewMarkdown(bundle);
  const findingsJson = JSON.stringify(bundle.findings, null, 2);

  await Promise.all([
    Bun.write(join(artifactDir, "walkthrough.md"), walkthroughMd),
    Bun.write(join(artifactDir, "review.md"), reviewMd),
    Bun.write(join(artifactDir, "findings.json"), findingsJson),
  ]);

  return artifactDir;
}
