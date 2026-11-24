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
      // Strip cargo-semver-checks baseline git worktree scratch prefix (`target/semver-checks/git-<sha>/<hash>/`)
      filePath = filePath.replace(/^.*?\btarget\/semver-checks\/git-[0-9a-f]+\/[0-9a-f]+\//i, "");
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
    /(?:^|\n)error:\s*no such command:\s*`?semver-checks`?|cargo-semver-checks:\s*(?:command )?not found/i.test(
      combined,
    )
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

// Why: A single SemVer lint (e.g. `function_missing` or `auto_trait_impl_removed`) can list
// dozens of symbols inside the same file. Grouping by `(filePath, lint)` emits one finding
// per file+lint listing all affected symbols instead of flooding the report with N rows per file.
export function semverViolationsToFindings(violations: readonly SemverViolation[]): Finding[] {
  const grouped = new Map<string, SemverViolation[]>();
  for (const v of violations) {
    const key = `${v.filePath}::${v.lint}`;
    const list = grouped.get(key) ?? [];
    list.push(v);
    grouped.set(key, list);
  }

  const findings: Finding[] = [];
  let idx = 0;
  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;
    idx += 1;
    const isMajor = group.some((v) => v.requiredBump !== "minor");
    const requiredBump = isMajor ? "major" : "minor";
    const symbols = Array.from(
      new Set(
        group.map((v) => (v.symbol ? `${v.symbol} (L${v.line})` : `L${v.line}`)).filter(Boolean),
      ),
    );
    const isMulti = group.length > 1;
    const title = isMulti
      ? `cargo-semver-checks (${first.lint}): ${first.headline} (${group.length} items in \`${first.filePath}\`)`
      : `cargo-semver-checks (${first.lint}): ${first.headline}`;

    findings.push(
      FindingSchema.parse({
        id: `audit-semver-${first.lint}-${idx}`,
        filePath: first.filePath,
        startLine: first.line,
        endLine: first.line,
        severity: requiredBump === "minor" ? "Minor" : "Major",
        type: "Bug",
        epistemicState: "VERIFIED-DEFECT",
        evidenceMechanism: "Correctness",
        title,
        body: [
          first.description || first.headline,
          symbols.length > 0
            ? `Affected public item(s): ${symbols.map((s) => `\`${s}\``).join(", ")}`
            : null,
          `Required SemVer bump: \`${requiredBump}\``,
        ]
          .filter(Boolean)
          .join("\n\n"),
        rootCause: `Breaking public API change detected by cargo-semver-checks (${first.lint}) in ${first.filePath}`,
        blastRadius: "Downstream crate consumers",
        reversible: true,
        dependsOn: null,
        verificationCommand: "cargo semver-checks check-release",
        traceability: `cargo-semver-checks lint ${first.lint} (${symbols.join(", ")})`,
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: `Resolve SemVer breakage \`${first.lint}\` in \`${first.filePath}\` (${symbols.join(", ")}) or document/bump the crate version accordingly. Verify with \`cargo semver-checks check-release\`.`,
        confidence: 1.0,
        source: "audit",
      }),
    );
  }
  return findings;
}
