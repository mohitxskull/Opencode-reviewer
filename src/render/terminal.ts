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
    ``,
    `--- Walkthrough Summary ---`,
    walkthrough.summary.trim(),
    ``,
    `--- Architectural Layers ---`,
  ];

  const sortedChanges = [...walkthrough.changes].sort(
    (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );
  for (const change of sortedChanges) {
    lines.push(`  [L${change.layer} | ${change.crateName}] ${change.filePath} — ${change.summary}`);
  }

  lines.push(``, `--- Findings (${bundle.findings.length}) ---`);
  if (bundle.findings.length === 0) {
    lines.push(`  No actionable findings.`);
  } else {
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

  lines.push(
    ``,
    `--- Local Artifacts ---`,
    `  Walkthrough: file://${resolve(artifactDir, "walkthrough.md")}`,
    `  Full Review: file://${resolve(artifactDir, "review.md")}`,
    `  Findings:    file://${resolve(artifactDir, "findings.json")}`,
    `================================================================================`,
  );

  return lines.join("\n");
}
