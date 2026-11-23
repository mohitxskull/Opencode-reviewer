import { join } from "node:path";

import { z } from "zod";

import {
  AnalyzerExecutionError,
  type CrateGraph,
  type DiffFileMap,
  type Finding,
  FindingSchema,
} from "../domain/models.ts";
import { buildScrubbedCargoEnv } from "../infra/env.ts";
import { runTrackedCommand } from "../infra/process.ts";
import { analyzeRustSourceAst, isLineInRegions } from "./ast.ts";
import { resolveFileArchitecturalLayer } from "./rust.ts";

export class MiriMissingError extends Error {
  constructor() {
    super(
      "`miri` (nightly toolchain component) is required when `--miri` is enabled, but it is not installed. Install it with: rustup toolchain install nightly && rustup +nightly component add miri",
    );
    this.name = "MiriMissingError";
  }
}

export const MiriDiagnosticSchema = z.object({
  kind: z.enum(["undefined_behavior", "memory_leak"]),
  message: z.string().min(1),
  filePath: z.string().default("src/lib.rs"),
  line: z.number().int().min(1).default(1),
  testName: z.string().nullable().default(null),
  help: z.string().nullable().default(null),
});
export type MiriDiagnostic = z.infer<typeof MiriDiagnosticSchema>;

export const MiriReportSchema = z.object({
  modifiedUnsafeFiles: z.array(z.string()).default([]),
  testedCrates: z.array(z.string()).default([]),
  skippedReason: z.string().nullable().default(null),
  diagnostics: z.array(MiriDiagnosticSchema).default([]),
});
export type MiriReport = z.infer<typeof MiriReportSchema>;

export async function findModifiedUnsafeFiles(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
): Promise<string[]> {
  const unsafeFiles: string[] = [];

  for (const [relPath, fileMap] of Object.entries(diffMap)) {
    if (!relPath.endsWith(".rs")) {
      continue;
    }
    const diskFile = Bun.file(join(repoRoot, relPath));
    if (!(await diskFile.exists())) {
      continue;
    }
    try {
      const ast = await analyzeRustSourceAst(await diskFile.text());
      if (ast.unsafeRegions.length === 0) {
        continue;
      }
      const touchesUnsafe = fileMap.hunks.some((hunk) =>
        hunk.rightSideLines.some((line) => isLineInRegions(line, ast.unsafeRegions)),
      );
      if (touchesUnsafe) {
        unsafeFiles.push(relPath);
      }
    } catch {
      // Skip files that cannot be parsed
    }
  }

  return unsafeFiles.sort();
}

export function parseMiriOutput(rawOutput: string): MiriDiagnostic[] {
  const diagnostics: MiriDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = rawOutput.replace(/\r\n/g, "\n").split("\n");

  let currentTestName: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const testHeader = line.match(/^----\s+([^\s]+)\s+stdout\s+----$/);
    if (testHeader?.[1]) {
      currentTestName = testHeader[1];
      continue;
    }

    const ubMatch = line.match(/^error:\s*(Undefined Behavior:\s*.+)$/i);
    const leakMatch = line.match(/^error:\s*(memory leaked:\s*.+)$/i);
    const match = ubMatch ?? leakMatch;
    if (!match?.[1]) {
      continue;
    }

    const kind: "undefined_behavior" | "memory_leak" = ubMatch
      ? "undefined_behavior"
      : "memory_leak";
    const message = match[1].trim();
    let filePath = "src/lib.rs";
    let lineNum = 1;
    let foundLoc = false;
    let help: string | null = null;

    // Look ahead up to 15 lines for location arrow (--> path:line:col) and = help:
    for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
      const nextLine = lines[j] ?? "";
      if (/^error:/.test(nextLine) || /^----\s+/.test(nextLine)) {
        break;
      }
      const locMatch = nextLine.match(/^\s*-->\s+([^:\s]+):(\d+):(\d+)/);
      if (locMatch?.[1] && !foundLoc) {
        filePath = locMatch[1].replace(/^\.\//, "");
        lineNum = Math.max(1, Number.parseInt(locMatch[2] ?? "1", 10) || 1);
        foundLoc = true;
      }
      const helpMatch = nextLine.match(/^\s*=\s*help:\s*(.+)$/);
      if (helpMatch?.[1] && !help) {
        help = helpMatch[1].trim();
      }
    }

    const key = `${kind}:${filePath}:${lineNum}:${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    diagnostics.push(
      MiriDiagnosticSchema.parse({
        kind,
        message,
        filePath,
        line: lineNum,
        testName: currentTestName,
        help,
      }),
    );
  }

  return diagnostics;
}

export type CargoMiriRunner = (
  repoRoot: string,
  packages: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoMiriRunner(
  repoRoot: string,
  packages: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ["cargo", "+nightly", "miri", "test"];
  for (const pkg of packages) {
    args.push("-p", pkg);
  }
  return await runTrackedCommand(args, {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
  });
}

export async function collectMiriReport(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  options: {
    enabled?: boolean;
    crateGraph?: CrateGraph;
    runner?: CargoMiriRunner;
  } = {},
): Promise<MiriReport | null> {
  if (!options.enabled) {
    return null;
  }

  const modifiedUnsafeFiles = await findModifiedUnsafeFiles(repoRoot, diffMap);
  if (modifiedUnsafeFiles.length === 0) {
    return MiriReportSchema.parse({
      modifiedUnsafeFiles: [],
      testedCrates: [],
      skippedReason: "No modified unsafe regions detected in PR diff",
      diagnostics: [],
    });
  }

  const crateGraph = options.crateGraph;
  const testedCrates = crateGraph
    ? Array.from(
        new Set(
          modifiedUnsafeFiles
            .map((fp) => resolveFileArchitecturalLayer(crateGraph, fp).crateName)
            .filter((name) => Boolean(crateGraph.crates[name])),
        ),
      )
    : [];

  const runner = options.runner ?? defaultCargoMiriRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot, testedCrates);
  const combined = `${stdout}\n${stderr}`;

  if (
    exitCode !== 0 &&
    !combined.includes("Undefined Behavior:") &&
    /(?:^|\n)error:\s*no such command:\s*`?miri`?|toolchain 'nightly' is not installed|component 'miri'[^\n]*not installed|can't find crate for `std`[^\n]*miri/i.test(
      combined,
    )
  ) {
    throw new MiriMissingError();
  }

  const diagnostics = parseMiriOutput(combined);
  if (exitCode !== 0 && diagnostics.length === 0 && !/test result:\s*ok\b/i.test(combined)) {
    throw new AnalyzerExecutionError("cargo +nightly miri test", exitCode, stderr || stdout);
  }

  return MiriReportSchema.parse({
    modifiedUnsafeFiles,
    testedCrates,
    skippedReason: null,
    diagnostics,
  });
}

export function formatMiriPromptSection(report: MiriReport): string {
  if (report.skippedReason) {
    return `## Miri (Undefined Behavior Verification)\nSkipped: ${report.skippedReason}.`;
  }
  if (report.diagnostics.length === 0) {
    return `## Miri (Undefined Behavior Verification)\nPassed with zero Undefined Behavior findings across modified unsafe files (${report.modifiedUnsafeFiles.join(", ")}).`;
  }

  const lines = report.diagnostics.map(
    (d) =>
      `- [CRITICAL ${d.kind.toUpperCase()}] \`${d.filePath}:${d.line}\`${d.testName ? ` (test \`${d.testName}\`)` : ""}: ${d.message}`,
  );
  return `## Miri (Undefined Behavior Verification)\n${lines.join("\n")}`;
}

export function miriReportToFindings(report: MiriReport): Finding[] {
  return report.diagnostics.map((d, idx) =>
    FindingSchema.parse({
      id: `audit-miri-${d.kind}-${idx + 1}`,
      filePath: d.filePath,
      startLine: d.line,
      endLine: d.line,
      severity: "Critical",
      type: "Soundness",
      epistemicState: "VERIFIED-DEFECT",
      evidenceMechanism: "Security",
      title: `Miri ${d.kind === "memory_leak" ? "Memory Leak" : "Undefined Behavior"}: ${d.message}`,
      body: [
        d.message,
        d.testName ? `Triggered during test: \`${d.testName}\`` : null,
        d.help ? `Miri help: ${d.help}` : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
      rootCause: `Miri detected ${d.kind.replace("_", " ")} at ${d.filePath}:${d.line}`,
      blastRadius: "Memory safety / Undefined Behavior across callers",
      reversible: true,
      dependsOn: null,
      verificationCommand: "cargo +nightly miri test",
      traceability: `cargo +nightly miri test${d.testName ? ` (${d.testName})` : ""}`,
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: `Fix the Miri ${d.kind.replace("_", " ")} at \`${d.filePath}:${d.line}\`: ${d.message}. Re-run \`cargo +nightly miri test\` until zero UB diagnostics remain.`,
      confidence: 1.0,
      source: "audit",
    }),
  );
}
