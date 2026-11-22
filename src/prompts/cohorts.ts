import type { CrateGraph, DiffFileMap } from "../models.ts";
import { resolveFileArchitecturalLayer } from "../rust.ts";

// Why: Large PRs (e.g. 50-150 files, >1 MB raw diff) exceed an LLM's effective
// reasoning window and inflate token usage by 10x if every file is dumped inline.
// We use Progressive Context Disclosure:
// - Tier 1 (Primary High-Risk Production Rust files): scored by risk signals
//   (`unsafe`, `.await`, locks, `select!`, `unwrap`/`panic!`, Clippy hits, non-test
//   layer) and included with compact annotated diff hunks (up to 7 files / 22k chars).
// - Tier 2 (Secondary / Test / Mechanical files): ONLY the file path, crate layer,
//   valid right-side hunk line ranges, and modified symbol names are listed so the
//   agent can request a specific file via `read` only if needed.
export const DEFAULT_MAX_INLINE_DIFF_CHARS = 22_000;
export const DEFAULT_MAX_TIER1_FILES = 7;
export const MAX_HUNK_LINES_BEFORE_COMPACT = 32;
export const MAX_CHARS_PER_FILE_DIFF = 5_500;

const HIGH_RISK_RUST_TOKEN_REGEX =
  /\b(?:unsafe|await|Mutex|RwLock|parking_lot|select!|unwrap|expect|panic!|transmute|from_raw|into_raw|Send|Sync)\b/;

export function scoreFileReviewPriority(
  fileMap: DiffFileMap,
  layer: number,
  testLayer: number,
  clippyFiles: ReadonlySet<string>,
): { score: number; isTestOrBench: boolean; addedLinesCount: number; riskSignals: string[] } {
  const isTestOrBench =
    layer >= testLayer ||
    fileMap.filePath.includes("/tests/") ||
    fileMap.filePath.startsWith("tests/") ||
    fileMap.filePath.startsWith("benches/") ||
    fileMap.filePath.includes("/benches/") ||
    fileMap.filePath.endsWith("_test.rs") ||
    fileMap.filePath.endsWith("_tests.rs") ||
    fileMap.filePath.endsWith("/tests.rs") ||
    fileMap.filePath === "tests.rs";

  let score = isTestOrBench ? 0 : 100 - Math.min(layer * 5, 30);
  if (fileMap.filePath.endsWith("Cargo.toml")) {
    score -= 40;
  }
  if (clippyFiles.has(fileMap.filePath)) {
    score += 50;
  }

  let addedLinesCount = 0;
  const riskSignalsSet = new Set<string>();

  for (const hunk of fileMap.hunks) {
    for (const line of hunk.annotatedLines) {
      if (line.includes("(+):")) {
        addedLinesCount += 1;
        const match = HIGH_RISK_RUST_TOKEN_REGEX.exec(line);
        if (match?.[0]) {
          riskSignalsSet.add(match[0]);
        }
      }
    }
  }

  score += riskSignalsSet.size * 25;
  score += Math.min(addedLinesCount, 80) * 0.25;

  return {
    score,
    isTestOrBench,
    addedLinesCount,
    riskSignals: Array.from(riskSignalsSet),
  };
}

export function compactAnnotatedLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_HUNK_LINES_BEFORE_COMPACT) {
    return [...lines];
  }
  const selected: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const isAdded = line.includes("(+):");
    const isNeighborAdded =
      (i > 0 && (lines[i - 1]?.includes("(+):") ?? false)) ||
      (i + 1 < lines.length && (lines[i + 1]?.includes("(+):") ?? false));
    if (isAdded || isNeighborAdded || i < 2 || i >= lines.length - 2) {
      selected.push(line);
    }
  }
  return selected.slice(0, MAX_HUNK_LINES_BEFORE_COMPACT);
}

export interface FileCohort {
  readonly id: string;
  readonly label: string;
  readonly filePaths: readonly string[];
}

function getSubsystemGroupKey(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) {
    return parts[0] ?? "root";
  }
  return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
}

// Why: When a PR touches 10-60+ Rust files across multiple subsystems, a single
// prompt cannot hold every file's diff hunks inline — causing single-call reviewers
// to only inspect the first 1-2 files and miss bugs in the remaining subsystems.
// Sharding modified files into subsystem cohorts ensures EVERY production Rust file
// in a large PR receives a dedicated audit without exceeding context limits.
export function groupDiffFilesIntoCohorts(
  diffMap: Readonly<Record<string, DiffFileMap>>,
  crateGraph: CrateGraph,
  maxFilesPerCohort = 7,
  maxCohorts = 8,
  maxCharsPerCohort = 26_000,
): FileCohort[] {
  const allPaths = Object.keys(diffMap);
  if (allPaths.length === 0) {
    return [];
  }

  const clippyEmpty = new Set<string>();
  const scored = allPaths
    .map((filePath) => {
      const fileMap = diffMap[filePath];
      const layerInfo = resolveFileArchitecturalLayer(crateGraph, filePath);
      const priority = fileMap
        ? scoreFileReviewPriority(fileMap, layerInfo.layer, crateGraph.testLayer, clippyEmpty)
        : { score: 0, isTestOrBench: true, addedLinesCount: 0, riskSignals: [] };
      const rawCompactedChars = fileMap
        ? fileMap.hunks.reduce(
            (acc, h) => acc + compactAnnotatedLines(h.annotatedLines).join("\n").length,
            0,
          )
        : 0;
      const approxChars = Math.min(rawCompactedChars, MAX_CHARS_PER_FILE_DIFF);
      return {
        filePath,
        groupKey: getSubsystemGroupKey(filePath),
        layer: layerInfo.layer,
        ...priority,
        approxChars,
      };
    })
    .sort((a, b) => {
      if (a.isTestOrBench !== b.isTestOrBench) {
        return a.isTestOrBench ? 1 : -1;
      }
      if (a.groupKey !== b.groupKey) {
        return a.groupKey.localeCompare(b.groupKey);
      }
      return b.score - a.score;
    });

  const prodFiles = scored.filter((f) => !f.isTestOrBench);
  const targetFiles = prodFiles.length > 0 ? prodFiles : scored;
  const totalApproxChars = targetFiles.reduce((acc, f) => acc + f.approxChars, 0);

  if (targetFiles.length <= maxFilesPerCohort && totalApproxChars <= maxCharsPerCohort) {
    return [
      {
        id: "cohort-1",
        label: targetFiles[0]?.groupKey ?? "all",
        filePaths: targetFiles.map((f) => f.filePath),
      },
    ];
  }

  const neededByCount = Math.ceil(targetFiles.length / maxFilesPerCohort);
  const neededByChars = Math.ceil(Math.max(1, totalApproxChars) / maxCharsPerCohort);
  const cohortCount = Math.min(
    targetFiles.length,
    Math.min(maxCohorts, Math.max(neededByCount, neededByChars)),
  );
  const baseSize = Math.floor(targetFiles.length / cohortCount);
  const remainder = targetFiles.length % cohortCount;

  const cohorts: FileCohort[] = [];
  let cursor = 0;
  for (let idx = 0; idx < cohortCount; idx++) {
    const size = baseSize + (idx < remainder ? 1 : 0);
    const slice = targetFiles.slice(cursor, cursor + size);
    cursor += size;
    if (slice.length === 0) {
      continue;
    }
    const groups = Array.from(new Set(slice.map((s) => s.groupKey)));
    const label =
      groups.length <= 2 ? groups.join("+") : `${groups[0]}+${groups[1]}+${groups.length - 2}more`;
    cohorts.push({
      id: `cohort-${idx + 1}`,
      label,
      filePaths: slice.map((s) => s.filePath),
    });
  }

  return cohorts;
}
