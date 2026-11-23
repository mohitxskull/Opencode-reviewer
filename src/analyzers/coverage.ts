import { isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import {
  AnalyzerExecutionError,
  type DiffFileMap,
  type Finding,
  FindingSchema,
} from "../domain/models.ts";
import { isRustTestOrBenchPath } from "../domain/paths.ts";
import { buildScrubbedCargoEnv } from "../infra/env.ts";
import { runTrackedCommand } from "../infra/process.ts";
import { analyzeRustSourceAst, isLineInRegions } from "./ast.ts";

export class CargoLlvmCovMissingError extends Error {
  constructor() {
    super(
      "`cargo-llvm-cov` is required when `--tools coverage` is enabled, but it is not installed. Install it with: cargo install cargo-llvm-cov",
    );
    this.name = "CargoLlvmCovMissingError";
  }
}

export const UncoveredLineRangeSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});
export type UncoveredLineRange = z.infer<typeof UncoveredLineRangeSchema>;

export const FileCoverageDeltaSchema = z.object({
  filePath: z.string().min(1),
  changedExecutableLines: z.number().int().min(0),
  coveredChangedLines: z.number().int().min(0),
  uncoveredLines: z.array(z.number().int().min(1)),
  uncoveredRanges: z.array(UncoveredLineRangeSchema),
  lineCoveragePercent: z.number().min(0).max(100),
});
export type FileCoverageDelta = z.infer<typeof FileCoverageDeltaSchema>;

export const CoverageReportSchema = z.object({
  files: z.array(FileCoverageDeltaSchema).default([]),
  totalChangedExecutableLines: z.number().int().min(0).default(0),
  totalUncoveredChangedLines: z.number().int().min(0).default(0),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

// LLVM cov export JSON segment tuple: [line, col, count, hasCount, isRegionEntry, isGapRegion]
type LlvmCovSegment = [number, number, number, boolean | number, boolean | number, ...unknown[]];

interface RawLlvmCovOutput {
  data?: Array<{
    files?: Array<{
      filename?: string;
      segments?: LlvmCovSegment[];
    }>;
  }>;
}

function normalizeCoveragePath(filename: string, repoRoot: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (isAbsolute(normalized)) {
    const rel = relative(repoRoot, normalized).replace(/\\/g, "/");
    return rel.replace(/^\.\//, "");
  }
  return normalized.replace(/^\.\//, "");
}

export function groupContiguousLines(lines: readonly number[]): UncoveredLineRange[] {
  if (lines.length === 0) {
    return [];
  }
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: UncoveredLineRange[] = [];
  let start = sorted[0] ?? 1;
  let prev = start;

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i] ?? prev;
    if (current === prev + 1) {
      prev = current;
    } else {
      ranges.push({ startLine: start, endLine: prev });
      start = current;
      prev = current;
    }
  }
  ranges.push({ startLine: start, endLine: prev });
  return ranges;
}

export async function parseLlvmCovJson(
  rawOutput: string,
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
): Promise<CoverageReport> {
  const jsonStart = rawOutput.indexOf("{");
  if (jsonStart === -1) {
    return CoverageReportSchema.parse({
      files: [],
      totalChangedExecutableLines: 0,
      totalUncoveredChangedLines: 0,
    });
  }

  let parsed: RawLlvmCovOutput;
  try {
    parsed = JSON.parse(rawOutput.slice(jsonStart)) as RawLlvmCovOutput;
  } catch {
    return CoverageReportSchema.parse({
      files: [],
      totalChangedExecutableLines: 0,
      totalUncoveredChangedLines: 0,
    });
  }

  const fileDeltas: FileCoverageDelta[] = [];
  let totalChangedExecutableLines = 0;
  let totalUncoveredChangedLines = 0;

  for (const dataEntry of parsed.data ?? []) {
    for (const fileEntry of dataEntry.files ?? []) {
      if (!fileEntry.filename || !fileEntry.segments) {
        continue;
      }
      const relPath = normalizeCoveragePath(fileEntry.filename, repoRoot);
      const diffFile = diffMap[relPath];
      if (!diffFile || isRustTestOrBenchPath(relPath)) {
        continue;
      }

      const changedLines = new Set<number>();
      for (const hunk of diffFile.hunks) {
        for (const line of hunk.rightSideLines) {
          changedLines.add(line);
        }
      }
      if (changedLines.size === 0) {
        continue;
      }

      // Exclude inline #[cfg(test)] regions using Tree-sitter AST when file exists on disk
      let testRegions: readonly { startLine: number; endLine: number }[] = [];
      const diskFile = Bun.file(join(repoRoot, relPath));
      if (await diskFile.exists()) {
        try {
          const ast = await analyzeRustSourceAst(await diskFile.text());
          testRegions = ast.testRegions;
        } catch {
          // Proceed without AST test-region exclusion if file cannot be parsed
        }
      }

      const lineHitMax = new Map<number, number>();
      for (const seg of fileEntry.segments) {
        const line = seg[0];
        const count = seg[2];
        const hasCount = Boolean(seg[3]);
        if (!hasCount || typeof line !== "number" || line < 1) {
          continue;
        }
        if (!changedLines.has(line) || isLineInRegions(line, testRegions)) {
          continue;
        }
        const prev = lineHitMax.get(line) ?? 0;
        if (count > prev || !lineHitMax.has(line)) {
          lineHitMax.set(line, Math.max(prev, count));
        }
      }

      const executableCount = lineHitMax.size;
      if (executableCount === 0) {
        continue;
      }

      const uncoveredLines = Array.from(lineHitMax.entries())
        .filter(([, count]) => count === 0)
        .map(([line]) => line)
        .sort((a, b) => a - b);

      const coveredCount = executableCount - uncoveredLines.length;
      const pct = Math.round((coveredCount / executableCount) * 1000) / 10;

      totalChangedExecutableLines += executableCount;
      totalUncoveredChangedLines += uncoveredLines.length;

      fileDeltas.push(
        FileCoverageDeltaSchema.parse({
          filePath: relPath,
          changedExecutableLines: executableCount,
          coveredChangedLines: coveredCount,
          uncoveredLines,
          uncoveredRanges: groupContiguousLines(uncoveredLines),
          lineCoveragePercent: pct,
        }),
      );
    }
  }

  fileDeltas.sort((a, b) => b.uncoveredLines.length - a.uncoveredLines.length);

  return CoverageReportSchema.parse({
    files: fileDeltas,
    totalChangedExecutableLines,
    totalUncoveredChangedLines,
  });
}

export type CargoLlvmCovRunner = (
  repoRoot: string,
  packages: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoLlvmCovRunner(
  repoRoot: string,
  packages: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!Bun.which("cargo-llvm-cov")) {
    throw new CargoLlvmCovMissingError();
  }
  const args = ["cargo", "llvm-cov", "--json"];
  for (const pkg of packages) {
    args.push("-p", pkg);
  }
  return await runTrackedCommand(args, {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
  });
}

export async function collectCargoLlvmCovReport(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  options: {
    enabled?: boolean;
    packages?: readonly string[];
    runner?: CargoLlvmCovRunner;
  } = {},
): Promise<CoverageReport | null> {
  if (!options.enabled) {
    return null;
  }

  const runner = options.runner ?? defaultCargoLlvmCovRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot, options.packages ?? []);
  const combined = `${stdout}\n${stderr}`;

  if (
    exitCode !== 0 &&
    !stdout.includes('"data"') &&
    /no such command:\s*`?llvm-cov`?|not found|ENOENT/i.test(combined)
  ) {
    throw new CargoLlvmCovMissingError();
  }

  if (exitCode !== 0 && !stdout.includes('"data"')) {
    throw new AnalyzerExecutionError("cargo llvm-cov", exitCode, stderr || stdout);
  }

  return await parseLlvmCovJson(stdout, repoRoot, diffMap);
}

export function formatCoveragePromptSection(report: CoverageReport): string {
  const uncoveredFiles = report.files.filter((f) => f.uncoveredLines.length > 0);
  if (uncoveredFiles.length === 0) {
    return "## Cargo LLVM-Cov (Changed-Line Test Coverage)\nAll instrumented changed production lines are covered by tests.";
  }

  const lines = uncoveredFiles.map((f) => {
    const rangeStr = f.uncoveredRanges
      .map((r) => (r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`))
      .join(", ");
    return `- \`${f.filePath}\`: ${f.lineCoveragePercent}% changed-line coverage (${f.uncoveredLines.length}/${f.changedExecutableLines} uncovered; lines: ${rangeStr})`;
  });

  return `## Cargo LLVM-Cov (Changed-Line Test Coverage)\n${lines.join("\n")}`;
}

// Why: Emitting a separate Finding for every contiguous uncovered line range produces
// 1,000+ rows on a multi-file PR (e.g. 20 tiny uncovered match/error arms per file),
// drowning out substantive code review findings. Grouping uncovered ranges into at most
// ONE finding per file keeps coverage actionable and compact.
export function coverageReportToFindings(report: CoverageReport): Finding[] {
  const findings: Finding[] = [];

  for (const file of report.files) {
    const firstRange = file.uncoveredRanges[0];
    if (!firstRange || file.uncoveredLines.length === 0) {
      continue;
    }
    const rangeLabels = file.uncoveredRanges
      .map((r) => (r.startLine === r.endLine ? `L${r.startLine}` : `L${r.startLine}-L${r.endLine}`))
      .join(", ");
    const rangeCount = file.uncoveredRanges.length;

    findings.push(
      FindingSchema.parse({
        id: `audit-coverage-${file.filePath}-${firstRange.startLine}-${firstRange.endLine}`,
        filePath: file.filePath,
        startLine: firstRange.startLine,
        endLine: firstRange.endLine,
        severity: "Minor",
        type: "Bug",
        epistemicState: "NEEDS-RUNTIME-VERIFICATION",
        evidenceMechanism: "Correctness",
        title: `Untested changed production code in \`${file.filePath}\` (${file.lineCoveragePercent}% coverage, ${file.uncoveredLines.length}/${file.changedExecutableLines} lines uncovered)`,
        body:
          `\`cargo llvm-cov\` recorded 0 test executions on ${file.uncoveredLines.length} of ${file.changedExecutableLines} modified executable production lines (${file.lineCoveragePercent}% coverage) across ${rangeCount} range(s) in \`${file.filePath}\`: ${rangeLabels}. ` +
          `Add unit or integration tests exercising these modified branches.`,
        rootCause: `Missing test coverage for modified production lines in ${file.filePath} (${rangeLabels})`,
        blastRadius: `Unverified behavior in ${file.filePath}`,
        reversible: true,
        dependsOn: null,
        verificationCommand: "cargo llvm-cov --json",
        traceability: `cargo-llvm-cov uncovered lines (${rangeLabels})`,
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: `Add deterministic tests covering the ${file.uncoveredLines.length} uncovered modified lines (${rangeLabels}) in \`${file.filePath}\`, then verify with \`cargo llvm-cov\`.`,
        confidence: 1.0,
        source: "audit",
      }),
    );
  }

  return findings;
}
