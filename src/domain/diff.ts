import parseDiff from "parse-diff";

import type { DiffFileMap, DiffHunk } from "./models.ts";

// Why: LLMs frequently miscount line numbers when reading raw `@@ -a,b +c,d @@`
// unified diff hunks containing interleaved `-` and `+` lines. Pre-rendering
// each right-side (context or `+`) line with its explicit `L0042 (+):` prefix
// inside the context package eliminates off-by-one line anchoring errors at the source.
export function formatAnnotatedDiffLine(
  lineNo: number,
  marker: "+" | " ",
  content: string,
): string {
  return `L${String(lineNo).padStart(4, "0")} (${marker}): ${content}`;
}

// Why: Reviewing .md documentation, plans, review reports, Cargo.lock, and CI YAML
// wastes tens of thousands of tokens on non-Rust prose and causes review lenses
// to lose focus on actual Rust code invariants. Only Rust source files (*.rs)
// and Cargo manifests (Cargo.toml) are eligible for Rust PR review.
export function isReviewableRustCodeFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalized.startsWith("docs/") ||
    normalized.startsWith(".github/") ||
    normalized.startsWith(".") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".lock")
  ) {
    return false;
  }
  const baseName = normalized.split("/").pop() ?? "";
  return normalized.endsWith(".rs") || baseName === "Cargo.toml" || normalized === "peer.toml";
}

function matchesAnyIgnoreGlob(filePath: string, ignoreGlobs: readonly string[]): boolean {
  if (ignoreGlobs.length === 0) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Never allow [diff].ignore to hide changes to peer.toml itself
  if (normalized === "peer.toml") {
    return false;
  }
  for (const pattern of ignoreGlobs) {
    const cleaned = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    const glob = new Bun.Glob(cleaned);
    if (glob.match(normalized)) {
      return true;
    }
    if (cleaned.endsWith("/**")) {
      const prefix = cleaned.slice(0, -3);
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function filterCodeOnlyDiffMap(
  diffMap: Readonly<Record<string, DiffFileMap>>,
  ignoreGlobs: readonly string[] = [],
): Record<string, DiffFileMap> {
  const filtered: Record<string, DiffFileMap> = {};
  for (const [filePath, fileMap] of Object.entries(diffMap)) {
    if (isReviewableRustCodeFile(filePath) && !matchesAnyIgnoreGlob(filePath, ignoreGlobs)) {
      filtered[filePath] = fileMap;
    }
  }
  return filtered;
}

function normalizeGitDiffPath(rawPath: string | undefined): string | null {
  if (!rawPath) {
    return null;
  }
  let cleaned = rawPath.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
    try {
      cleaned = JSON.parse(cleaned) as string;
    } catch {
      cleaned = cleaned.slice(1, -1);
    }
  }
  if (cleaned === "/dev/null") {
    return null;
  }
  if (cleaned.startsWith("b/") || cleaned.startsWith("a/")) {
    cleaned = cleaned.slice(2);
  }
  return cleaned.length > 0 ? cleaned : null;
}

export function parseUnifiedDiff(diffText: string): Record<string, DiffFileMap> {
  const result: Record<string, DiffFileMap> = {};
  if (!diffText || diffText.trim().length === 0) {
    return result;
  }

  const parsedFiles = parseDiff(diffText);
  for (const file of parsedFiles) {
    if (file.deleted) {
      continue;
    }
    const filePath = normalizeGitDiffPath(file.to);
    if (!filePath) {
      continue;
    }

    const hunks: DiffHunk[] = [];
    for (const chunk of file.chunks) {
      if (chunk.newLines === 0 || chunk.newStart < 1) {
        continue;
      }
      const annotatedLines: string[] = [];
      const rightSideLines: number[] = [];

      for (const change of chunk.changes) {
        if (change.type === "add") {
          if (change.content === "\\ No newline at end of file") {
            continue;
          }
          const lineNo = change.ln;
          const content = change.content.startsWith("+") ? change.content.slice(1) : change.content;
          rightSideLines.push(lineNo);
          annotatedLines.push(formatAnnotatedDiffLine(lineNo, "+", content));
        } else if (change.type === "normal") {
          if (change.content === "\\ No newline at end of file") {
            continue;
          }
          const lineNo = change.ln2;
          const content = change.content.startsWith(" ") ? change.content.slice(1) : change.content;
          rightSideLines.push(lineNo);
          annotatedLines.push(formatAnnotatedDiffLine(lineNo, " ", content));
        }
      }

      if (rightSideLines.length === 0) {
        continue;
      }

      const lastLine = rightSideLines[rightSideLines.length - 1] ?? chunk.newStart;
      hunks.push({
        oldStart: chunk.oldStart,
        oldCount: chunk.oldLines,
        newStart: chunk.newStart,
        newEnd: lastLine,
        header: chunk.content,
        annotatedLines,
        rightSideLines,
      });
    }

    if (hunks.length > 0) {
      const existing = result[filePath];
      if (existing) {
        existing.hunks.push(...hunks);
      } else {
        result[filePath] = {
          filePath,
          hunks,
        };
      }
    }
  }

  return result;
}

export function snapRangeToHunk(
  fileMap: DiffFileMap,
  startLine: number,
  endLine: number,
  maxDistance = 3,
): { startLine: number; endLine: number } | null {
  if (startLine < 1 || startLine > endLine) {
    return null;
  }

  // 1. Exact containment inside a single right-side hunk
  for (const hunk of fileMap.hunks) {
    if (startLine >= hunk.newStart && endLine <= hunk.newEnd) {
      return { startLine, endLine };
    }
  }

  // 2. Reject any range that overlaps or bridges two distinct hunks
  const touchedHunks = fileMap.hunks.filter(
    (hunk) =>
      Math.max(startLine, hunk.newStart - maxDistance) <=
      Math.min(endLine, hunk.newEnd + maxDistance),
  );
  if (touchedHunks.length !== 1) {
    return null;
  }

  const candidate = touchedHunks[0];
  if (!candidate) {
    return null;
  }

  const startDelta =
    startLine < candidate.newStart
      ? candidate.newStart - startLine
      : startLine > candidate.newEnd
        ? startLine - candidate.newEnd
        : 0;
  const endDelta =
    endLine < candidate.newStart
      ? candidate.newStart - endLine
      : endLine > candidate.newEnd
        ? endLine - candidate.newEnd
        : 0;

  if (startDelta > maxDistance || endDelta > maxDistance) {
    return null;
  }

  const snappedStart = Math.max(candidate.newStart, Math.min(candidate.newEnd, startLine));
  const snappedEnd = Math.max(snappedStart, Math.min(candidate.newEnd, endLine));
  return { startLine: snappedStart, endLine: snappedEnd };
}
