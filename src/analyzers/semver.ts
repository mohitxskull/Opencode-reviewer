import { isAbsolute, relative } from "node:path";

import { z } from "zod";

import { AnalyzerExecutionError, type Finding, FindingSchema } from "../domain/models.ts";
import { buildScrubbedCargoEnv } from "../infra/env.ts";
import { runTrackedCommand } from "../infra/process.ts";

export class CargoSemverChecksMissingError extends Error {
  constructor() {
    super(
      "`cargo-semver-checks` is required when `--tools semver` is enabled, but it is not installed. Install it with: cargo install cargo-semver-checks",
    );
    this.name = "CargoSemverChecksMissingError";
  }
}

export const SemverViolationSchema = z.object({
  lint: z.string().min(1),
  headline: z.string().min(1),
  requiredBump: z.enum(["major", "minor", "unknown"]).default("major"),
  description: z.string().default(""),
  filePath: z.string().default("Cargo.toml"),
  line: z.number().int().min(1).default(1),
  symbol: z.string().nullable().default(null),
});
export type SemverViolation = z.infer<typeof SemverViolationSchema>;

export function parseCargoSemverOutput(rawOutput: string, repoRoot?: string): SemverViolation[] {
  const violations: SemverViolation[] = [];
  const seen = new Set<string>();
  const normalized = rawOutput.replace(/\r\n/g, "\n");
  const headerRegex = /^---\s+failure\s+([a-zA-Z0-9_-]+):\s*(.+?)\s*---\s*$/gm;

  const matches: Array<{ lint: string; headline: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null = headerRegex.exec(normalized);
  while (match !== null) {
    matches.push({
      lint: match[1] ?? "semver_violation",
      headline: match[2] ?? "SemVer violation",
      start: match.index,
      end: match.index + match[0].length,
    });
    match = headerRegex.exec(normalized);
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current) {
      continue;
    }
    const nextStart = matches[i + 1]?.start ?? normalized.length;
    const block = normalized.slice(current.end, nextStart);

    const descMatch = block.match(/Description:\s*([\s\S]*?)(?:\n\s*(?:Ref:|Impl:|Failed in:)|$)/);
    const description = descMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";

    const bumpMatch = block.match(/Required\s+SemVer\s+update:\s*(major|minor)/i);
    const requiredBump: "major" | "minor" | "unknown" =
      bumpMatch?.[1]?.toLowerCase() === "minor"
        ? "minor"
        : bumpMatch?.[1]?.toLowerCase() === "major"
          ? "major"
          : "unknown";

    const failedInMatch = block.match(/Failed in:\s*([\s\S]*?)(?:\n\n|$)/);
    const failedLines = failedInMatch?.[1]
      ? failedInMatch[1]
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

    if (failedLines.length === 0) {
      const key = `${current.lint}:Cargo.toml:1`;
      if (!seen.has(key)) {
        seen.add(key);
        violations.push(
          SemverViolationSchema.parse({
            lint: current.lint,
            headline: current.headline,
            requiredBump,
            description,
            filePath: "Cargo.toml",
            line: 1,
            symbol: null,
          }),
        );
      }
      continue;
    }

    for (const lineText of failedLines) {
      const fileLineMatch = lineText.match(/\bin\s+(?:file\s+)?([^\s:]+):(\d+)/);
      let filePath = fileLineMatch?.[1]?.replace(/\\/g, "/") ?? "Cargo.toml";
      if (repoRoot && isAbsolute(filePath)) {
        filePath = relative(repoRoot, filePath).replace(/\\/g, "/");
      }
      filePath = filePath.replace(/^\.\//, "") || "Cargo.toml";
      const lineNum = Math.max(1, Number.parseInt(fileLineMatch?.[2] ?? "1", 10) || 1);
      const symbolMatch = lineText.match(/^([^,]+?)(?:,\s*(?:previously\s+)?in\s+(?:file\s+)?|$)/);
      const symbol = symbolMatch?.[1]?.trim() || null;

      const key = `${current.lint}:${filePath}:${lineNum}:${symbol ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      violations.push(
        SemverViolationSchema.parse({
          lint: current.lint,
          headline: current.headline,
          requiredBump,
          description,
          filePath,
          line: lineNum,
          symbol,
        }),
      );
    }
  }

  return violations;
}

export type CargoSemverRunner = (
  repoRoot: string,
  baseSha: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoSemverRunner(
  repoRoot: string,
  baseSha: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!Bun.which("cargo-semver-checks")) {
    throw new CargoSemverChecksMissingError();
  }
  return await runTrackedCommand(
    ["cargo", "semver-checks", "check-release", "--baseline-rev", baseSha],
    {
      cwd: repoRoot,
      env: buildScrubbedCargoEnv(),
    },
  );
}

export async function collectCargoSemverViolations(
  repoRoot: string,
  options: { enabled?: boolean; baseSha: string; runner?: CargoSemverRunner },
): Promise<SemverViolation[]> {
  if (!options.enabled) {
    return [];
  }

  const runner = options.runner ?? defaultCargoSemverRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot, options.baseSha);
  const combined = `${stdout}\n${stderr}`;

  if (
    exitCode !== 0 &&
    !combined.includes("--- failure ") &&
    /no such command:\s*`?semver-checks`?|not found|ENOENT/i.test(combined)
  ) {
    throw new CargoSemverChecksMissingError();
  }

  const parsed = parseCargoSemverOutput(combined, repoRoot);
  if (exitCode !== 0 && parsed.length === 0) {
    throw new AnalyzerExecutionError("cargo semver-checks", exitCode, stderr || stdout);
  }
  return parsed;
}

export function formatSemverPromptSection(violations: readonly SemverViolation[]): string {
  if (violations.length === 0) {
    return "";
  }
  const lines = violations.map(
    (v) =>
      `- [${v.requiredBump.toUpperCase()}] \`${v.filePath}:${v.line}\` (\`${v.lint}\`): ${v.headline}${v.symbol ? ` — ${v.symbol}` : ""}`,
  );
  return `## Cargo SemVer Checks (Breaking Public API Changes)\n${lines.join("\n")}`;
}

export function semverViolationsToFindings(violations: readonly SemverViolation[]): Finding[] {
  return violations.map((v, idx) =>
    FindingSchema.parse({
      id: `audit-semver-${v.lint}-${idx + 1}`,
      filePath: v.filePath,
      startLine: v.line,
      endLine: v.line,
      severity: v.requiredBump === "minor" ? "Minor" : "Major",
      type: "Bug",
      epistemicState: "VERIFIED-DEFECT",
      evidenceMechanism: "Correctness",
      title: `cargo-semver-checks (${v.lint}): ${v.headline}`,
      body: [
        v.description || v.headline,
        v.symbol ? `Affected public item: \`${v.symbol}\`` : null,
        `Required SemVer bump: \`${v.requiredBump}\``,
      ]
        .filter(Boolean)
        .join("\n\n"),
      rootCause: `Breaking public API change detected by cargo-semver-checks (${v.lint})`,
      blastRadius: "Downstream crate consumers",
      reversible: true,
      dependsOn: null,
      verificationCommand: "cargo semver-checks check-release",
      traceability: `cargo-semver-checks lint ${v.lint}`,
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: `Resolve SemVer breakage \`${v.lint}\` at \`${v.filePath}:${v.line}\` (${v.headline}${v.symbol ? `: ${v.symbol}` : ""}) or document/bump the crate version accordingly. Verify with \`cargo semver-checks check-release\`.`,
      confidence: 1.0,
      source: "audit",
    }),
  );
}
