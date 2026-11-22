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
    const startLine = snapped ? snapped.startLine : diag.startLine;
    const endLine = snapped ? snapped.endLine : diag.endLine;

    const severity = diag.level === "error" ? "Critical" : "Minor";
    const type = diag.level === "error" ? "Bug" : "Idioms";
    const codeLabel = diag.code ? ` (${diag.code})` : "";

    results.push(
      FindingSchema.parse({
        id: `clippy-${i + 1}`,
        filePath: diag.filePath,
        startLine,
        endLine,
        severity,
        type,
        title: `Compiler/Clippy ${diag.level}${codeLabel}: ${diag.message}`,
        body: diag.rendered.trim() || diag.message,
        suggestion: diag.suggestedReplacement,
        suggestionVerified: false,
        agentPrompt: `Resolve Cargo Clippy/rustc diagnostic${codeLabel} in \`${diag.filePath}\` lines ${startLine}-${endLine}: ${diag.message}`,
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

function clusterOverlappingFindings(candidates: readonly Finding[]): Finding[] {
  const merged: Finding[] = [];
  for (const candidate of candidates) {
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
  return merged;
}

function sortFindingsDeterministically(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
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

export interface PartitionedFindings {
  readonly inlineFindings: Finding[];
  readonly outsideDiffFindings: Finding[];
  readonly nitpickFindings: Finding[];
}

// Why: GitHub's Pull Request Review API rejects inline thread comments on lines
// outside the PR's right-side diff hunks with HTTP 422. Instead of silently dropping
// valid Rust findings that fall outside the modified diff lines (or span across
// two hunks), we partition them into `outsideDiffFindings` so they are rendered in
// CodeRabbit's `<details><summary>⚠️ Outside diff range comments (N)</summary>`
// block in the PR review body, while low-severity/nitpick findings under `chill`
// are grouped into `<details><summary>🧹 Nitpick comments (K)</summary>`.
export function partitionAndFilterFindings(
  findings: readonly Finding[],
  diffMap: Readonly<Record<string, DiffFileMap>>,
  profile: ReviewProfile,
): PartitionedFindings {
  const rawInline: Finding[] = [];
  const rawOutside: Finding[] = [];

  for (const finding of findings) {
    if (finding.severity === "None") {
      continue;
    }
    const fileMap = diffMap[finding.filePath];
    const snapped = fileMap ? snapRangeToHunk(fileMap, finding.startLine, finding.endLine) : null;
    if (snapped) {
      rawInline.push(
        FindingSchema.parse({
          ...finding,
          startLine: snapped.startLine,
          endLine: snapped.endLine,
        }),
      );
    } else {
      rawOutside.push(FindingSchema.parse(finding));
    }
  }

  const clusteredInline = sortFindingsDeterministically(clusterOverlappingFindings(rawInline));
  const clusteredOutside = sortFindingsDeterministically(clusterOverlappingFindings(rawOutside));

  const inlineFindings: Finding[] = [];
  const outsideDiffFindings: Finding[] = [];
  const nitpickFindings: Finding[] = [];

  for (const f of clusteredInline) {
    if (allowsFindingForProfile(profile, f)) {
      inlineFindings.push(f);
    } else if (profile === "chill") {
      nitpickFindings.push(f);
    }
  }

  for (const f of clusteredOutside) {
    if (allowsFindingForProfile(profile, f)) {
      outsideDiffFindings.push(f);
    } else if (profile === "chill") {
      nitpickFindings.push(f);
    }
  }

  return {
    inlineFindings,
    outsideDiffFindings,
    nitpickFindings,
  };
}
