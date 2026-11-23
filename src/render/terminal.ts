import { resolve } from "node:path";

import { isOptionalAnalyzerFinding, type ReviewBundle } from "../domain/models.ts";

const ALL_OPTIONAL_TOOLS = ["deny", "geiger", "semver", "coverage", "miri"] as const;

export interface TerminalReportOptions {
  readonly verbose?: boolean;
  readonly enabledTools?: readonly string[];
  readonly verdictSummary?: string;
  readonly nextStepHint?: string;
}

export function formatTerminalReport(
  bundle: ReviewBundle,
  repoRoot: string,
  artifactDir: string,
  options: TerminalReportOptions = {},
): string {
  const absRoot = resolve(repoRoot);
  const baseShort = bundle.diffBaseSha.slice(0, 7);
  const headShort = bundle.headSha.slice(0, 7);
  const { walkthrough } = bundle;

  const enabledSet = new Set(options.enabledTools ?? []);
  const unrunOptional = ALL_OPTIONAL_TOOLS.filter((t) => !enabledSet.has(t));
  const activeOptional = ALL_OPTIONAL_TOOLS.filter((t) => enabledSet.has(t));

  const lines: string[] = [
    `================================================================================`,
    `Peer Rust PR Review — ${bundle.pr.owner}/${bundle.pr.repo}#${bundle.pr.number}: ${bundle.pr.title}`,
    `================================================================================`,
    `Range: ${baseShort}..${headShort} (${bundle.isIncremental ? "incremental" : "full"}) | Profile: ${bundle.profile}`,
    `Effort: ${walkthrough.triage.reviewEffort}/5 | Merge Risk: ${walkthrough.triage.mergeRisk}`,
    `Rationale: ${walkthrough.triage.rationale}`,
    `Analyzers: core (clippy, cargo-audit, tree-sitter AST)${activeOptional.length > 0 ? ` + optional [${activeOptional.join(", ")}]` : ""}${unrunOptional.length > 0 ? ` | not enabled: [${unrunOptional.join(", ")}] (pass --tools all or run 'peer doctor')` : ""}`,
  ];

  if (options.verdictSummary) {
    lines.push(``, `--- Skeptic Verdict Ledger ---`, options.verdictSummary);
  }

  if (bundle.failedCohorts && bundle.failedCohorts.length > 0) {
    lines.push(
      `WARNING: Partial review (${bundle.failedCohorts.length} cohort(s) failed: ${bundle.failedCohorts.join(", ")})`,
    );
  }

  lines.push(``, `--- Walkthrough Summary ---`, walkthrough.summary.trim());

  if (options.verbose) {
    lines.push(``, `--- Architectural Layers ---`);
    const sortedChanges = [...walkthrough.changes].sort(
      (a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath),
    );
    for (const change of sortedChanges) {
      lines.push(
        `  [L${change.layer} | ${change.crateName}] ${change.filePath} — ${change.summary}`,
      );
    }
  }

  const outside = bundle.outsideDiffFindings ?? [];
  const nitpicks = bundle.nitpickFindings ?? [];
  const allActionable = [...bundle.findings, ...outside];
  const coreFindings = allActionable.filter((f) => !isOptionalAnalyzerFinding(f));
  const optionalFindings = allActionable.filter((f) => isOptionalAnalyzerFinding(f));
  const totalActionable = allActionable.length;
  const verifiedCount = allActionable.filter(
    (f) => f.suggestion !== null && f.suggestionVerified,
  ).length;

  lines.push(
    ``,
    `--- Findings Summary (Substantive Review: ${coreFindings.length} | Optional Analyzers: ${optionalFindings.length} | Verified Patches: ${verifiedCount} | Total Actionable: ${totalActionable} | Nitpicks: ${nitpicks.length}) ---`,
  );
  const displayList = options.verbose || coreFindings.length === 0 ? allActionable : coreFindings;
  if (displayList.length > 0) {
    const tableRows = displayList.map((f) => ({
      ID: f.id,
      Severity: f.severity,
      Type: f.type,
      Patch:
        f.suggestion !== null && f.suggestionVerified
          ? "✓ cargo check"
          : f.suggestion !== null
            ? "unverified"
            : "—",
      Location: `${f.filePath}:${f.startLine}`,
      Title: f.title.length > 48 ? `${f.title.slice(0, 45)}...` : f.title,
    }));
    lines.push(
      Bun.inspect.table(tableRows, ["ID", "Severity", "Type", "Patch", "Location", "Title"]),
    );
    if (!options.verbose && optionalFindings.length > 0 && coreFindings.length > 0) {
      lines.push(
        `  (+ ${optionalFindings.length} optional analyzer diagnostic(s) from coverage/semver/geiger/deny/miri in review.md; pass --exclude-tools coverage,semver to omit)`,
      );
    }
  } else {
    lines.push(`  No actionable findings.`);
  }

  if (options.verbose) {
    if (bundle.findings.length > 0) {
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
  } else if (totalActionable > 0) {
    lines.push(
      `  (Pass --verbose to print full finding bodies to stdout, or read Latest Link below)`,
    );
  }

  lines.push(
    ``,
    `--- Stage Report & Diagnostics ---`,
    `  Stage Report: file://${resolve(artifactDir, "report.md")}`,
    `  Latest Link:  file://${resolve(artifactDir, "..", "review.md")}`,
    `  Fix Queue:    file://${resolve(artifactDir, "..", "todo.md")}`,
    `  Fix Queue JSON: file://${resolve(artifactDir, "..", "todo.json")}`,
    `  Run Manifest: file://${resolve(artifactDir, "..", "run.json")}`,
    `  Audit JSONL:  file://${resolve(artifactDir, "..", "audit.jsonl")}`,
  );

  if (options.nextStepHint) {
    lines.push(``, `--- Next Step ---`, options.nextStepHint);
  }

  lines.push(`================================================================================`);

  return lines.join("\n");
}
