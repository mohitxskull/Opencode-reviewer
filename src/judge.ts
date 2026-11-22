import { snapRangeToHunk } from "./diff.ts";
import {
  allowsFindingForProfile,
  type ClippyDiagnostic,
  type DiffFileMap,
  type Finding,
  FindingSchema,
  type ReviewProfile,
  SEVERITY_RANK,
} from "./models.ts";

export function clippyToFindings(
  diagnostics: readonly ClippyDiagnostic[],
  diffMap: Readonly<Record<string, DiffFileMap>>,
): Finding[] {
  const results: Finding[] = [];

  for (let i = 0; i < diagnostics.length; i++) {
    const diag = diagnostics[i];
    if (!diag) {
      continue;
    }

    const fileMap = diffMap[diag.filePath];
    if (!fileMap) {
      continue;
    }

    const snapped = snapRangeToHunk(fileMap, diag.startLine, diag.endLine);
    if (!snapped) {
      continue;
    }

    const severity = diag.level === "error" ? "Critical" : "Minor";
    const type = diag.level === "error" ? "Bug" : "Idioms";
    const codeLabel = diag.code ? ` (${diag.code})` : "";

    results.push(
      FindingSchema.parse({
        id: `clippy-${i + 1}`,
        filePath: diag.filePath,
        startLine: snapped.startLine,
        endLine: snapped.endLine,
        severity,
        type,
        title: `Compiler/Clippy ${diag.level}${codeLabel}: ${diag.message}`,
        body: diag.rendered.trim() || diag.message,
        suggestion: diag.suggestedReplacement,
        suggestionVerified: false,
        agentPrompt: `Resolve Cargo Clippy/rustc diagnostic${codeLabel} in \`${diag.filePath}\` lines ${snapped.startLine}-${snapped.endLine}: ${diag.message}`,
        confidence: 1.0,
        source: "clippy",
      }),
    );
  }

  return results;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function mergeTwoFindings(a: Finding, b: Finding): Finding {
  const aRank = SEVERITY_RANK[a.severity];
  const bRank = SEVERITY_RANK[b.severity];

  // Prefer the finding with higher severity (lower numerical rank); on tie, prefer non-clippy lens explanation
  const primary = aRank < bRank ? a : bRank < aRank ? b : a.source !== "clippy" ? a : b;
  const secondary = primary === a ? b : a;

  const combinedSuggestion = primary.suggestion ?? secondary.suggestion;
  const combinedPrompt =
    primary.agentPrompt.includes(secondary.agentPrompt) ||
    secondary.agentPrompt.includes(primary.agentPrompt)
      ? primary.agentPrompt
      : `${primary.agentPrompt}\nAdditional context (${secondary.source}): ${secondary.agentPrompt}`;

  const combinedBody =
    primary.body.includes(secondary.title) || primary.title === secondary.title
      ? primary.body
      : `${primary.body}\n\nRelated (${secondary.source}): ${secondary.title}`;

  return FindingSchema.parse({
    ...primary,
    body: combinedBody,
    suggestion: combinedSuggestion,
    agentPrompt: combinedPrompt,
    confidence: Math.max(primary.confidence, secondary.confidence),
  });
}

export function deduplicateAndFilterFindings(
  findings: readonly Finding[],
  diffMap: Readonly<Record<string, DiffFileMap>>,
  profile: ReviewProfile,
): Finding[] {
  // 1. Anchor and snap every finding to a single right-side diff hunk
  const anchored: Finding[] = [];
  for (const finding of findings) {
    const fileMap = diffMap[finding.filePath];
    if (!fileMap) {
      continue;
    }
    const snapped = snapRangeToHunk(fileMap, finding.startLine, finding.endLine);
    if (!snapped) {
      continue;
    }
    anchored.push(
      FindingSchema.parse({
        ...finding,
        startLine: snapped.startLine,
        endLine: snapped.endLine,
      }),
    );
  }

  // 2. Cluster and merge overlapping findings on the same file
  const merged: Finding[] = [];
  for (const candidate of anchored) {
    const overlapIdx = merged.findIndex(
      (existing) =>
        existing.filePath === candidate.filePath &&
        rangesOverlap(existing.startLine, existing.endLine, candidate.startLine, candidate.endLine),
    );
    if (overlapIdx === -1) {
      merged.push(candidate);
    } else {
      const existing = merged[overlapIdx];
      if (existing) {
        merged[overlapIdx] = mergeTwoFindings(existing, candidate);
      }
    }
  }

  // 3. Apply profile gate and deterministic sort by (severityRank, filePath, startLine)
  return merged
    .filter((f) => allowsFindingForProfile(profile, f))
    .sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      const fileDiff = a.filePath.localeCompare(b.filePath);
      if (fileDiff !== 0) {
        return fileDiff;
      }
      return a.startLine - b.startLine;
    });
}
