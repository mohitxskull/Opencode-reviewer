import { resolve } from "node:path";
import type { ReviewBundle } from "../models.ts";

export function formatTerminalReport(
  bundle: ReviewBundle,
  repoRoot: string,
  artifactDir: string,
): string {
  const absRoot = resolve(repoRoot);
  const baseShort = bundle.diffBaseSha.slice(0, 7);
  const headShort = bundle.headSha.slice(0, 7);
  const { walkthrough } = bundle;

  const lines: string[] = [
    `================================================================================`,
    `Peer Rust PR Review — ${bundle.pr.owner}/${bundle.pr.repo}#${bundle.pr.number}: ${bundle.pr.title}`,
    `================================================================================`,
    `Range: ${baseShort}..${headShort} (${bundle.isIncremental ? "incremental" : "full"}) | Profile: ${bundle.profile}`,
    `Effort: ${walkthrough.triage.reviewEffort}/5 | Merge Risk: ${walkthrough.triage.mergeRisk}`,
    `Rationale: ${walkthrough.triage.rationale}`,
  ];

  if (bundle.failedCohorts && bundle.failedCohorts.length > 0) {
    lines.push(
      `WARNING: Partial review (${bundle.failedCohorts.length} cohort(s) failed: ${bundle.failedCohorts.join(", ")})`,
    );
  }

  lines.push(
    ``,
    `--- Walkthrough Summary ---`,
    walkthrough.summary.trim(),
    ``,
    `--- Architectural Layers ---`,
  );

  const sortedChanges = [...walkthrough.changes].sort(
    (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );
  for (const change of sortedChanges) {
    lines.push(`  [L${change.layer} | ${change.crateName}] ${change.filePath} — ${change.summary}`);
  }

  const outside = bundle.outsideDiffFindings ?? [];
  const nitpicks = bundle.nitpickFindings ?? [];
  const totalActionable = bundle.findings.length + outside.length;

  lines.push(
    ``,
    `--- Findings Summary (Total Actionable: ${totalActionable} | Inline: ${bundle.findings.length} | Outside Diff: ${outside.length} | Nitpicks: ${nitpicks.length}) ---`,
  );
  if (bundle.findings.length === 0) {
    lines.push(`  No inline diff findings.`);
  } else {
    lines.push(`  [Inline Diff Findings (${bundle.findings.length})]`);
    for (const f of bundle.findings) {
      const absFile = resolve(absRoot, f.filePath);
      const fileUri = `file://${absFile}#L${f.startLine}-L${f.endLine}`;
      const verifiedBadge =
        f.suggestion !== null && f.suggestionVerified ? " [suggestion: cargo check OK]" : "";
      lines.push(
        `  * [${f.severity} | ${f.type}] ${f.title}${verifiedBadge}`,
        `    Location: ${fileUri}`,
        `    ${f.body.split("\n")[0] ?? ""}`,
      );
    }
  }

  if (outside.length > 0) {
    lines.push(``, `  [Outside Diff Range Findings (${outside.length})]`);
    for (const f of outside) {
      const absFile = resolve(absRoot, f.filePath);
      const fileUri = `file://${absFile}#L${f.startLine}-L${f.endLine}`;
      const verifiedBadge =
        f.suggestion !== null && f.suggestionVerified ? " [suggestion: cargo check OK]" : "";
      lines.push(
        `  * [${f.severity} | ${f.type}] ${f.title}${verifiedBadge}`,
        `    Location: ${fileUri}`,
        `    ${f.body.split("\n")[0] ?? ""}`,
      );
    }
  }

  if (nitpicks.length > 0) {
    lines.push(``, `  [Nitpick Findings (${nitpicks.length})]`);
    for (const f of nitpicks) {
      const absFile = resolve(absRoot, f.filePath);
      const fileUri = `file://${absFile}#L${f.startLine}-L${f.endLine}`;
      lines.push(`  * [${f.severity} | ${f.type}] ${f.title} (${fileUri})`);
    }
  }

  lines.push(
    ``,
    `--- Local Artifacts & Audit Log ---`,
    `  Walkthrough: file://${resolve(artifactDir, "walkthrough.md")}`,
    `  Full Review: file://${resolve(artifactDir, "review.md")}`,
    `  Findings:    file://${resolve(artifactDir, "findings.json")}`,
    `  Audit JSONL: file://${resolve(artifactDir, "audit.jsonl")}`,
    `================================================================================`,
  );

  return lines.join("\n");
}
