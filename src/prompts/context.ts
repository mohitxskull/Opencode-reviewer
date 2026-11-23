import type { AuditLogger } from "../audit.ts";
import {
  extractSymbolsFromFileMap,
  formatSymbolGraphSummary,
  type RustSymbolGraph,
} from "../graph.ts";
import { formatLearningsPromptSection, type RepoLearning } from "../learnings.ts";
import type {
  ClippyDiagnostic,
  CrateGraph,
  DiffFileMap,
  PullRequestMetadata,
  SecurityAdvisory,
} from "../models.ts";
import { resolveFileArchitecturalLayer } from "../rust.ts";
import { formatSecurityAdvisoriesPromptSection } from "../security.ts";
import { formatGeigerPromptSection, type GeigerReport } from "../tools/geiger.ts";
import {
  compactAnnotatedLines,
  DEFAULT_MAX_INLINE_DIFF_CHARS,
  DEFAULT_MAX_TIER1_FILES,
  MAX_CHARS_PER_FILE_DIFF,
  scoreFileReviewPriority,
} from "./cohorts.ts";

export interface ReviewContext {
  readonly repoRoot: string;
  readonly pr: PullRequestMetadata;
  readonly diffBaseSha: string;
  readonly headSha: string;
  readonly isIncremental: boolean;
  readonly fresh?: boolean;
  readonly crateGraph: CrateGraph;
  readonly diffMap: Readonly<Record<string, DiffFileMap>>;
  readonly clippyDiagnostics: readonly ClippyDiagnostic[];
  readonly securityAdvisories?: readonly SecurityAdvisory[];
  readonly geigerReport?: GeigerReport | null;
  readonly symbolGraph?: RustSymbolGraph;
  readonly learnings?: readonly RepoLearning[];
  readonly auditLogger?: AuditLogger;
}

export function buildWalkthroughContextPrompt(context: ReviewContext): string {
  const sections: string[] = [];

  sections.push(
    `# Pull Request Context\n` +
      `- Repository: ${context.pr.owner}/${context.pr.repo}\n` +
      `- PR #${context.pr.number}: ${context.pr.title}\n` +
      `- Author: ${context.pr.author}\n` +
      `- Range: ${context.diffBaseSha.slice(0, 7)}..${context.headSha.slice(0, 7)} (${context.isIncremental ? "incremental delta" : "full PR diff"})\n\n` +
      `## PR Description\n${(context.pr.body.trim() || "(no description)").slice(0, 2000)}`,
  );

  const clippyFiles = new Set(context.clippyDiagnostics.map((d) => d.filePath));
  const enrichedFiles = Object.keys(context.diffMap)
    .map((filePath) => {
      const fileMap = context.diffMap[filePath];
      const layerInfo = resolveFileArchitecturalLayer(context.crateGraph, filePath);
      const priority = fileMap
        ? scoreFileReviewPriority(
            fileMap,
            layerInfo.layer,
            context.crateGraph.testLayer,
            clippyFiles,
          )
        : { score: 0, isTestOrBench: true, addedLinesCount: 0, riskSignals: [] };
      const symbols = fileMap
        ? extractSymbolsFromFileMap(fileMap).map((s) => `${s.kind} ${s.name}`)
        : [];
      return {
        filePath,
        crateName: layerInfo.crateName,
        layer: layerInfo.layer,
        addedLinesCount: priority.addedLinesCount,
        riskSignals: priority.riskSignals,
        symbols,
      };
    })
    .sort((a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath));

  const fileListLines = enrichedFiles.map((f) => {
    const symSuffix = f.symbols.length > 0 ? ` | symbols: ${f.symbols.slice(0, 4).join(", ")}` : "";
    const riskSuffix = f.riskSignals.length > 0 ? ` | signals: ${f.riskSignals.join(",")}` : "";
    return `- [Layer ${f.layer} | crate: ${f.crateName}] \`${f.filePath}\` (+${f.addedLinesCount} lines${symSuffix}${riskSuffix})`;
  });

  sections.push(
    `## Modified Rust Code Files (${enrichedFiles.length} file(s), Ordered by Cargo Crate Dependency Layer)\n${fileListLines.join("\n") || "(none)"}`,
  );

  if (context.symbolGraph && context.symbolGraph.nodes.length > 0) {
    sections.push(
      `## Rust Symbol & Cross-Workspace Call-Site Graph\n${formatSymbolGraphSummary(context.symbolGraph)}`,
    );
  }

  return sections.join("\n\n");
}

export function buildReviewContextPrompt(
  context: ReviewContext,
  maxInlineDiffChars = DEFAULT_MAX_INLINE_DIFF_CHARS,
  maxTier1Files = DEFAULT_MAX_TIER1_FILES,
): string {
  const sections: string[] = [];

  sections.push(
    `# Pull Request Context\n` +
      `- Repository: ${context.pr.owner}/${context.pr.repo}\n` +
      `- PR #${context.pr.number}: ${context.pr.title}\n` +
      `- Author: ${context.pr.author}\n` +
      `- Range: ${context.diffBaseSha.slice(0, 7)}..${context.headSha.slice(0, 7)} (${context.isIncremental ? "incremental delta" : "full PR diff"})\n\n` +
      `## PR Description\n${(context.pr.body.trim() || "(no description)").slice(0, 2000)}`,
  );

  if (context.learnings && context.learnings.length > 0) {
    sections.push(formatLearningsPromptSection(context.learnings));
  }

  const clippyFiles = new Set(context.clippyDiagnostics.map((d) => d.filePath));

  const enrichedFiles = Object.keys(context.diffMap)
    .map((filePath) => {
      const fileMap = context.diffMap[filePath];
      const layerInfo = resolveFileArchitecturalLayer(context.crateGraph, filePath);
      const priority = fileMap
        ? scoreFileReviewPriority(
            fileMap,
            layerInfo.layer,
            context.crateGraph.testLayer,
            clippyFiles,
          )
        : { score: 0, isTestOrBench: true, addedLinesCount: 0, riskSignals: [] };
      const symbols = fileMap
        ? extractSymbolsFromFileMap(fileMap).map((s) => `${s.kind} ${s.name}`)
        : [];
      return {
        filePath,
        fileMap,
        crateName: layerInfo.crateName,
        layer: layerInfo.layer,
        ...priority,
        symbols,
      };
    })
    .sort((a, b) => a.layer - b.layer || a.filePath.localeCompare(b.filePath));

  const fileListLines = enrichedFiles.map((f) => {
    const ranges = f.fileMap
      ? f.fileMap.hunks.map((h) => `${h.newStart}..${h.newEnd}`).join(", ")
      : "";
    const symSuffix = f.symbols.length > 0 ? ` | symbols: ${f.symbols.slice(0, 5).join(", ")}` : "";
    return `- [Layer ${f.layer} | crate: ${f.crateName}] \`${f.filePath}\` (hunks: ${ranges}${symSuffix})`;
  });
  sections.push(
    `## Modified Rust Code Files (Ordered by Cargo Crate Dependency Layer)\n${fileListLines.join("\n") || "(none)"}`,
  );

  if (context.symbolGraph && context.symbolGraph.nodes.length > 0) {
    sections.push(
      `## Rust Symbol & Cross-Workspace Call-Site Graph\n${formatSymbolGraphSummary(context.symbolGraph)}`,
    );
  }

  if (context.securityAdvisories && context.securityAdvisories.length > 0) {
    sections.push(formatSecurityAdvisoriesPromptSection(context.securityAdvisories));
  }

  if (context.geigerReport) {
    sections.push(formatGeigerPromptSection(context.geigerReport));
  }

  if (context.clippyDiagnostics.length > 0) {
    const clippyLines = context.clippyDiagnostics.map(
      (d) =>
        `- [${d.level.toUpperCase()}] \`${d.filePath}:${d.startLine}-${d.endLine}\` (${d.code ?? "rustc"}): ${d.message}` +
        (d.suggestedReplacement ? ` | suggestion: \`${d.suggestedReplacement.trim()}\`` : ""),
    );
    sections.push(`## Local Cargo Clippy / Compiler Diagnostics\n${clippyLines.join("\n")}`);
  } else {
    sections.push(`## Local Cargo Clippy / Compiler Diagnostics\nZero warnings or errors.`);
  }

  const rankedByScore = [...enrichedFiles].sort(
    (a, b) => b.score - a.score || a.layer - b.layer || a.filePath.localeCompare(b.filePath),
  );

  const tier1Paths = new Set<string>();
  const tier1Blocks: string[] = [];
  let usedChars = 0;

  for (const entry of rankedByScore) {
    if (!entry.fileMap) {
      continue;
    }
    if (tier1Blocks.length >= maxTier1Files) {
      break;
    }
    if (entry.isTestOrBench && tier1Blocks.length > 0) {
      continue;
    }

    const hunkTexts: string[] = [];
    let fileChars = 0;
    for (const hunk of entry.fileMap.hunks) {
      const lines = compactAnnotatedLines(hunk.annotatedLines);
      const hunkStr =
        `${hunk.header} (right-side valid range: ${hunk.newStart}..${hunk.newEnd})\n` +
        lines.join("\n");
      if (fileChars + hunkStr.length > MAX_CHARS_PER_FILE_DIFF && hunkTexts.length > 0) {
        hunkTexts.push(
          `... (${entry.fileMap.hunks.length - hunkTexts.length} more hunk(s) in \`${entry.filePath}\`; valid ranges: ${entry.fileMap.hunks.map((h) => `${h.newStart}..${h.newEnd}`).join(", ")})`,
        );
        break;
      }
      hunkTexts.push(hunkStr);
      fileChars += hunkStr.length;
    }
    const block =
      `### File: \`${entry.filePath}\` (Layer ${entry.layer}, crate \`${entry.crateName}\`)\n` +
      `\`\`\`diff\n${hunkTexts.join("\n\n")}\n\`\`\``;

    if (usedChars + block.length > maxInlineDiffChars && tier1Blocks.length > 0) {
      continue;
    }

    tier1Paths.add(entry.filePath);
    tier1Blocks.push(block);
    usedChars += block.length;
  }

  const tier2Lines: string[] = [];
  for (const entry of enrichedFiles) {
    if (tier1Paths.has(entry.filePath) || !entry.fileMap) {
      continue;
    }
    const allRanges = entry.fileMap.hunks.map((h) => `${h.newStart}..${h.newEnd}`);
    const ranges =
      allRanges.length > 4
        ? `${allRanges.slice(0, 4).join(", ")} (+${allRanges.length - 4} more)`
        : allRanges.join(", ");
    const symLabel =
      entry.symbols.length > 0
        ? ` | modified symbols: ${entry.symbols.slice(0, 4).join(", ")}`
        : "";
    tier2Lines.push(
      `- \`${entry.filePath}\` (Layer ${entry.layer}, crate \`${entry.crateName}\`, +${entry.addedLinesCount} lines, valid hunks: ${ranges}${symLabel})`,
    );
  }

  sections.push(
    `## Tier 1: Primary High-Risk Rust Diff Hunks (Inline)\n${tier1Blocks.join("\n\n") || "(none)"}`,
  );

  if (tier2Lines.length > 0) {
    sections.push(
      `## Tier 2: Secondary & Test Files (Paths Only — Request via \`read\` Tool Only If Needed)\n` +
        tier2Lines.join("\n"),
    );
  }

  return sections.join("\n\n");
}
