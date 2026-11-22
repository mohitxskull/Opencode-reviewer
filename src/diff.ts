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

export function parseUnifiedDiff(diffText: string): Record<string, DiffFileMap> {
  const result: Record<string, DiffFileMap> = {};
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");

  let currentFilePath: string | null = null;
  let currentHunk: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCursor: number;
    header: string;
    annotatedLines: string[];
    rightSideLines: number[];
  } | null = null;

  const flushHunk = () => {
    if (!currentFilePath || !currentHunk || currentHunk.rightSideLines.length === 0) {
      currentHunk = null;
      return;
    }
    const lastLine =
      currentHunk.rightSideLines[currentHunk.rightSideLines.length - 1] ?? currentHunk.newStart;
    const hunk: DiffHunk = {
      oldStart: currentHunk.oldStart,
      oldCount: currentHunk.oldCount,
      newStart: currentHunk.newStart,
      newEnd: lastLine,
      header: currentHunk.header,
      annotatedLines: currentHunk.annotatedLines,
      rightSideLines: currentHunk.rightSideLines,
    };
    const existing = result[currentFilePath];
    if (existing) {
      existing.hunks.push(hunk);
    } else {
      result[currentFilePath] = {
        filePath: currentFilePath,
        hunks: [hunk],
      };
    }
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      currentFilePath = null;
      continue;
    }

    if (line.startsWith("--- ")) {
      flushHunk();
      continue;
    }

    if (line.startsWith("+++ ")) {
      flushHunk();
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        currentFilePath = null;
      } else {
        currentFilePath = target.startsWith("b/") ? target.slice(2) : target;
      }
      continue;
    }

    const hunkHeaderMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunkHeaderMatch) {
      flushHunk();
      if (!currentFilePath) {
        continue;
      }
      const oldStart = Number.parseInt(hunkHeaderMatch[1] ?? "0", 10);
      const oldCount = Number.parseInt(hunkHeaderMatch[2] ?? "1", 10);
      const newStart = Number.parseInt(hunkHeaderMatch[3] ?? "1", 10);
      const newCount = Number.parseInt(hunkHeaderMatch[4] ?? "1", 10);
      if (newCount === 0 || newStart < 1) {
        currentHunk = null;
        continue;
      }
      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCursor: newStart,
        header: line,
        annotatedLines: [],
        rightSideLines: [],
      };
      continue;
    }

    if (!currentHunk || !currentFilePath) {
      continue;
    }

    if (line.startsWith("+")) {
      const content = line.slice(1);
      const lineNo = currentHunk.newCursor;
      currentHunk.rightSideLines.push(lineNo);
      currentHunk.annotatedLines.push(formatAnnotatedDiffLine(lineNo, "+", content));
      currentHunk.newCursor += 1;
    } else if (line.startsWith(" ")) {
      const content = line.slice(1);
      const lineNo = currentHunk.newCursor;
      currentHunk.rightSideLines.push(lineNo);
      currentHunk.annotatedLines.push(formatAnnotatedDiffLine(lineNo, " ", content));
      currentHunk.newCursor += 1;
    } else if (line.startsWith("-")) {
      // Removed line exists only on LEFT side; does not advance right-side line cursor
    }
  }

  flushHunk();
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
