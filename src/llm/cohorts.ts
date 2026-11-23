import { resolveFileArchitecturalLayer } from "../analyzers/rust.ts";
import type { CrateGraph, DiffFileMap } from "../domain/models.ts";
import { isRustTestOrBenchPath } from "../domain/paths.ts";

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
  const isTestOrBench = layer >= testLayer || isRustTestOrBenchPath(fileMap.filePath);

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

function slugifyCohortLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Partitions ALL modified production Rust files (or all modified files if test-only)
 * into subsystem-grouped review cohorts with NO silent truncation cap, so coding CLIs
 * can fan out parallel subagents and audit 100% of production diff hunks on large PRs.
 */
export function planAllSubsystemCohorts(
  diffMap: Readonly<Record<string, DiffFileMap>>,
  crateGraph: CrateGraph,
  maxFilesPerCohort = 6,
  maxCharsPerCohort = 65_000,
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
      const rawChars = fileMap
        ? fileMap.hunks.reduce((acc, h) => acc + h.annotatedLines.join("\n").length, 0)
        : 0;
      return {
        filePath,
        groupKey: getSubsystemGroupKey(filePath),
        layer: layerInfo.layer,
        ...priority,
        rawChars,
      };
    })
    .sort((a, b) => {
      if (a.isTestOrBench !== b.isTestOrBench) {
        return a.isTestOrBench ? 1 : -1;
      }
      if (a.groupKey !== b.groupKey) {
        return a.groupKey.localeCompare(b.groupKey);
      }
      return b.score - a.score || a.filePath.localeCompare(b.filePath);
    });

  const prodFiles = scored.filter((f) => !f.isTestOrBench);
  const targetFiles = prodFiles.length > 0 ? prodFiles : scored;

  const grouped = new Map<string, typeof targetFiles>();
  for (const entry of targetFiles) {
    const bucket = grouped.get(entry.groupKey) ?? [];
    bucket.push(entry);
    grouped.set(entry.groupKey, bucket);
  }

  const rawBuckets: Array<{ label: string; files: string[]; chars: number }> = [];
  for (const [groupKey, entries] of grouped.entries()) {
    let curFiles: string[] = [];
    let curChars = 0;
    for (const entry of entries) {
      const wouldExceedCount = curFiles.length >= maxFilesPerCohort;
      const wouldExceedChars = curFiles.length > 0 && curChars + entry.rawChars > maxCharsPerCohort;
      if (wouldExceedCount || wouldExceedChars) {
        rawBuckets.push({ label: groupKey, files: curFiles, chars: curChars });
        curFiles = [];
        curChars = 0;
      }
      curFiles.push(entry.filePath);
      curChars += entry.rawChars;
    }
    if (curFiles.length > 0) {
      rawBuckets.push({ label: groupKey, files: curFiles, chars: curChars });
    }
  }

  // Merge tiny adjacent buckets (<=2 files and small char count) so small subsystems don't create excessive cohorts
  const merged: Array<{ labels: string[]; files: string[]; chars: number }> = [];
  for (const bucket of rawBuckets) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.files.length + bucket.files.length <= maxFilesPerCohort &&
      prev.chars + bucket.chars <= Math.floor(maxCharsPerCohort * 0.65)
    ) {
      prev.labels.push(bucket.label);
      prev.files.push(...bucket.files);
      prev.chars += bucket.chars;
    } else {
      merged.push({ labels: [bucket.label], files: [...bucket.files], chars: bucket.chars });
    }
  }

  return merged.map((m, idx) => {
    const uniqueLabels = Array.from(new Set(m.labels));
    const label =
      uniqueLabels.length <= 2
        ? uniqueLabels.join("+")
        : `${uniqueLabels[0]}+${uniqueLabels[1]}+${uniqueLabels.length - 2}more`;
    const num = String(idx + 1).padStart(2, "0");
    const slug = slugifyCohortLabel(uniqueLabels[0] ?? "cohort");
    return {
      id: `cohort-${num}-${slug || "group"}`,
      label,
      filePaths: m.files,
    };
  });
}
