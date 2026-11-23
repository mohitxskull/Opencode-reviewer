import { z } from "zod";

import {
  AnalyzerExecutionError,
  type CrateGraph,
  type Finding,
  FindingSchema,
} from "../domain/models.ts";
import { buildScrubbedCargoEnv } from "../infra/env.ts";
import { runTrackedCommand } from "../infra/process.ts";

export class CargoGeigerMissingError extends Error {
  constructor() {
    super(
      "`cargo-geiger` is required when `--tools geiger` is enabled, but it is not installed. Install it with: cargo install cargo-geiger",
    );
    this.name = "CargoGeigerMissingError";
  }
}

export const GeigerUnsafeCountsSchema = z.object({
  functions: z.number().int().min(0).default(0),
  exprs: z.number().int().min(0).default(0),
  itemImpls: z.number().int().min(0).default(0),
  itemTraits: z.number().int().min(0).default(0),
  methods: z.number().int().min(0).default(0),
  total: z.number().int().min(0).default(0),
});
export type GeigerUnsafeCounts = z.infer<typeof GeigerUnsafeCountsSchema>;

export const GeigerPackageReportSchema = z.object({
  packageName: z.string().min(1),
  version: z.string().default("0.0.0"),
  isWorkspaceMember: z.boolean().default(false),
  forbidsUnsafe: z.boolean().default(false),
  usedUnsafe: GeigerUnsafeCountsSchema,
  unusedUnsafeTotal: z.number().int().min(0).default(0),
});
export type GeigerPackageReport = z.infer<typeof GeigerPackageReportSchema>;

export const GeigerReportSchema = z.object({
  packages: z.array(GeigerPackageReportSchema).default([]),
  totalWorkspaceUsedUnsafe: z.number().int().min(0).default(0),
});
export type GeigerReport = z.infer<typeof GeigerReportSchema>;

interface RawGeigerCounter {
  safe?: number;
  unsafe_?: number;
}

interface RawGeigerMetrics {
  functions?: RawGeigerCounter;
  exprs?: RawGeigerCounter;
  item_impls?: RawGeigerCounter;
  item_traits?: RawGeigerCounter;
  methods?: RawGeigerCounter;
}

interface RawGeigerOutput {
  packages?: Array<{
    package?: {
      id?: {
        name?: string;
        version?: string;
      };
    };
    unsafety?: {
      used?: RawGeigerMetrics;
      unused?: RawGeigerMetrics;
      forbids_unsafe?: boolean;
    };
  }>;
}

function extractCounts(metrics?: RawGeigerMetrics): GeigerUnsafeCounts {
  const functions = metrics?.functions?.unsafe_ ?? 0;
  const exprs = metrics?.exprs?.unsafe_ ?? 0;
  const itemImpls = metrics?.item_impls?.unsafe_ ?? 0;
  const itemTraits = metrics?.item_traits?.unsafe_ ?? 0;
  const methods = metrics?.methods?.unsafe_ ?? 0;
  return GeigerUnsafeCountsSchema.parse({
    functions,
    exprs,
    itemImpls,
    itemTraits,
    methods,
    total: functions + exprs + itemImpls + itemTraits + methods,
  });
}

export function parseCargoGeigerJson(rawOutput: string, crateGraph?: CrateGraph): GeigerReport {
  const jsonStart = rawOutput.indexOf("{");
  if (jsonStart === -1) {
    return GeigerReportSchema.parse({ packages: [], totalWorkspaceUsedUnsafe: 0 });
  }

  let parsed: RawGeigerOutput;
  try {
    parsed = JSON.parse(rawOutput.slice(jsonStart)) as RawGeigerOutput;
  } catch {
    return GeigerReportSchema.parse({ packages: [], totalWorkspaceUsedUnsafe: 0 });
  }

  const workspaceCrates = new Set(Object.keys(crateGraph?.crates ?? {}));
  const packages: GeigerPackageReport[] = [];
  const seen = new Set<string>();
  let totalWorkspaceUsedUnsafe = 0;

  for (const entry of parsed.packages ?? []) {
    const name = entry.package?.id?.name;
    if (!name) {
      continue;
    }
    const version = entry.package?.id?.version ?? "0.0.0";
    const key = `${name}@${version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const isWorkspaceMember = workspaceCrates.size > 0 ? workspaceCrates.has(name) : true;
    const usedUnsafe = extractCounts(entry.unsafety?.used);
    const unusedUnsafe = extractCounts(entry.unsafety?.unused);
    const forbidsUnsafe = Boolean(entry.unsafety?.forbids_unsafe);

    if (isWorkspaceMember) {
      totalWorkspaceUsedUnsafe += usedUnsafe.total;
    }

    if (isWorkspaceMember || usedUnsafe.total > 0) {
      packages.push(
        GeigerPackageReportSchema.parse({
          packageName: name,
          version,
          isWorkspaceMember,
          forbidsUnsafe,
          usedUnsafe,
          unusedUnsafeTotal: unusedUnsafe.total,
        }),
      );
    }
  }

  packages.sort((a, b) => {
    if (a.isWorkspaceMember !== b.isWorkspaceMember) {
      return a.isWorkspaceMember ? -1 : 1;
    }
    return b.usedUnsafe.total - a.usedUnsafe.total || a.packageName.localeCompare(b.packageName);
  });

  return GeigerReportSchema.parse({ packages, totalWorkspaceUsedUnsafe });
}

export type CargoGeigerRunner = (
  repoRoot: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoGeigerRunner(
  repoRoot: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!Bun.which("cargo-geiger")) {
    throw new CargoGeigerMissingError();
  }
  return await runTrackedCommand(["cargo", "geiger", "--output-format", "Json"], {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
  });
}

export async function collectCargoGeigerReport(
  repoRoot: string,
  options: { enabled?: boolean; crateGraph?: CrateGraph; runner?: CargoGeigerRunner } = {},
): Promise<GeigerReport | null> {
  if (!options.enabled) {
    return null;
  }

  const runner = options.runner ?? defaultCargoGeigerRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot);
  const combined = `${stdout}\n${stderr}`;

  if (
    exitCode !== 0 &&
    !stdout.includes('"packages"') &&
    /no such command:\s*`?geiger`?|not found|ENOENT/i.test(combined)
  ) {
    throw new CargoGeigerMissingError();
  }

  if (exitCode !== 0 && !stdout.includes('"packages"')) {
    throw new AnalyzerExecutionError("cargo geiger", exitCode, stderr || stdout);
  }

  return parseCargoGeigerJson(stdout, options.crateGraph);
}

export function formatGeigerPromptSection(report: GeigerReport): string {
  const unsafeWorkspace = report.packages.filter(
    (p) => p.isWorkspaceMember && p.usedUnsafe.total > 0,
  );
  if (unsafeWorkspace.length === 0) {
    return "## Cargo Geiger (Unsafe Surface)\nZero used `unsafe` items detected in workspace crates.";
  }

  const lines = unsafeWorkspace.map(
    (p) =>
      `- \`${p.packageName}\` (${p.version}): **${p.usedUnsafe.total} used unsafe** ` +
      `(fns=${p.usedUnsafe.functions}, exprs=${p.usedUnsafe.exprs}, impls=${p.usedUnsafe.itemImpls}, traits=${p.usedUnsafe.itemTraits}, methods=${p.usedUnsafe.methods})` +
      (p.forbidsUnsafe ? " [forbids_unsafe]" : ""),
  );

  return `## Cargo Geiger (Unsafe Surface)\n${lines.join("\n")}`;
}

export function geigerReportToFindings(
  report: GeigerReport,
  modifiedCrates?: ReadonlySet<string>,
  crateGraph?: CrateGraph,
): Finding[] {
  const results: Finding[] = [];

  for (const pkg of report.packages) {
    if (!pkg.isWorkspaceMember || pkg.usedUnsafe.total === 0) {
      continue;
    }
    if (modifiedCrates && modifiedCrates.size > 0 && !modifiedCrates.has(pkg.packageName)) {
      continue;
    }

    const manifestDir = crateGraph?.crates[pkg.packageName]?.manifestDir ?? "";
    const manifestPath = manifestDir
      ? `${manifestDir.replace(/\/+$/, "")}/Cargo.toml`
      : "Cargo.toml";

    results.push(
      FindingSchema.parse({
        id: `audit-geiger-${pkg.packageName}`,
        filePath: manifestPath,
        startLine: 1,
        endLine: 1,
        severity: "Minor",
        type: "Soundness",
        epistemicState: "NEEDS-RUNTIME-VERIFICATION",
        evidenceMechanism: "Security",
        title: `cargo-geiger [${pkg.packageName}]: ${pkg.usedUnsafe.total} used unsafe item(s) detected`,
        body:
          `Modified workspace crate \`${pkg.packageName}\` contains ${pkg.usedUnsafe.total} used \`unsafe\` item(s) ` +
          `(functions: ${pkg.usedUnsafe.functions}, expressions: ${pkg.usedUnsafe.exprs}, impls: ${pkg.usedUnsafe.itemImpls}, traits: ${pkg.usedUnsafe.itemTraits}, methods: ${pkg.usedUnsafe.methods}). ` +
          `Audit each \`unsafe\` block for documented \`// SAFETY:\` invariants and consider \`#![forbid(unsafe_code)]\` where feasible.`,
        rootCause: `Unsafe code surface in modified crate ${pkg.packageName}`,
        blastRadius: `Crate ${pkg.packageName} and downstream dependents`,
        reversible: true,
        dependsOn: null,
        verificationCommand: "cargo geiger",
        traceability: `cargo-geiger report for ${pkg.packageName}@${pkg.version}`,
        suggestion: null,
        suggestionVerified: false,
        agentPrompt: `Audit all ${pkg.usedUnsafe.total} used \`unsafe\` item(s) in crate \`${pkg.packageName}\`, ensure every \`unsafe\` block has a valid \`// SAFETY:\` comment proving its invariants, or replace with safe Rust. Run \`cargo geiger\` to verify.`,
        confidence: 1.0,
        source: "audit",
      }),
    );
  }

  return results;
}
