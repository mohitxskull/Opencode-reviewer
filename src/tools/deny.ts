import { join } from "node:path";
import { z } from "zod";
import { buildScrubbedCargoEnv } from "../env.ts";
import { type Finding, FindingSchema } from "../models.ts";

export class CargoDenyMissingError extends Error {
  constructor() {
    super(
      "`cargo-deny` is required to run supply-chain/license/ban checks (`deny.toml` or `--deny`), but it is not installed. Install it with: cargo install cargo-deny",
    );
    this.name = "CargoDenyMissingError";
  }
}

export const CargoDenyDiagnosticSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  crateName: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});
export type CargoDenyDiagnostic = z.infer<typeof CargoDenyDiagnosticSchema>;

interface CargoDenyJsonLine {
  type?: string;
  fields?: {
    severity?: string;
    code?: string;
    message?: string;
    notes?: string[];
    graphs?: Array<{ Krate?: { name?: string; version?: string } }>;
  };
}

export function parseCargoDenyJsonLines(rawOutput: string): CargoDenyDiagnostic[] {
  const results: CargoDenyDiagnostic[] = [];
  const seen = new Set<string>();

  const jsonlPayload = rawOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .join("\n");
  if (jsonlPayload.length === 0) {
    return results;
  }

  const parsedEntries: CargoDenyJsonLine[] = [];
  let offset = 0;
  while (offset < jsonlPayload.length) {
    const chunk = Bun.JSONL.parseChunk(jsonlPayload.slice(offset));
    for (const val of chunk.values) {
      if (val && typeof val === "object") {
        parsedEntries.push(val as CargoDenyJsonLine);
      }
    }
    if (chunk.done) {
      break;
    }
    if (chunk.read > 0) {
      offset += chunk.read;
    } else {
      const nextNl = jsonlPayload.indexOf("\n", offset);
      if (nextNl === -1) break;
      offset = nextNl + 1;
    }
  }

  for (const parsed of parsedEntries) {
    if (parsed.type !== "diagnostic" || !parsed.fields) {
      continue;
    }
    const sev = parsed.fields.severity;
    if (sev !== "error" && sev !== "warning") {
      continue;
    }
    const code = parsed.fields.code ?? "cargo-deny";
    const message = parsed.fields.message ?? "cargo-deny violation";
    const crateName = parsed.fields.graphs?.[0]?.Krate?.name ?? null;
    const key = `${code}:${crateName ?? ""}:${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    results.push(
      CargoDenyDiagnosticSchema.parse({
        code,
        severity: sev,
        message,
        crateName,
        notes: parsed.fields.notes ?? [],
      }),
    );
  }

  return results;
}

export type CargoDenyRunner = (
  repoRoot: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoDenyRunner(
  repoRoot: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!Bun.which("cargo-deny")) {
    throw new CargoDenyMissingError();
  }
  const proc = Bun.spawn(["cargo", "deny", "check", "--format", "json"], {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function collectCargoDenyDiagnostics(
  repoRoot: string,
  options: { force?: boolean; runner?: CargoDenyRunner } = {},
): Promise<CargoDenyDiagnostic[]> {
  const hasDenyToml = await Bun.file(join(repoRoot, "deny.toml")).exists();
  if (!hasDenyToml && !options.force) {
    return [];
  }

  const runner = options.runner ?? defaultCargoDenyRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot);
  const combined = `${stdout}\n${stderr}`;

  if (
    exitCode !== 0 &&
    !combined.includes('"type":"diagnostic"') &&
    !combined.includes('"type": "diagnostic"') &&
    /no such command:\s*`?deny`?|not found|ENOENT/i.test(combined)
  ) {
    throw new CargoDenyMissingError();
  }

  return parseCargoDenyJsonLines(combined);
}

export function denyDiagnosticsToFindings(diagnostics: readonly CargoDenyDiagnostic[]): Finding[] {
  return diagnostics.map((d, idx) =>
    FindingSchema.parse({
      id: `audit-deny-${d.code}-${d.crateName ?? idx + 1}`,
      filePath: "Cargo.toml",
      startLine: 1,
      endLine: 1,
      severity: d.severity === "error" ? "Major" : "Minor",
      type: "Security",
      epistemicState: "VERIFIED-DEFECT",
      evidenceMechanism: "Security",
      title: `cargo-deny (${d.code})${d.crateName ? ` [${d.crateName}]` : ""}: ${d.message}`,
      body: [d.message, ...d.notes].join("\n\n"),
      rootCause: `Supply-chain / policy violation (${d.code})`,
      blastRadius: d.crateName ? `Dependency ${d.crateName}` : "Workspace dependencies",
      reversible: true,
      dependsOn: null,
      verificationCommand: "cargo deny check",
      traceability: `cargo-deny rule ${d.code}`,
      suggestion: null,
      suggestionVerified: false,
      agentPrompt: `Resolve cargo-deny violation (${d.code})${d.crateName ? ` for crate \`${d.crateName}\`` : ""}: ${d.message}. Run \`cargo deny check\` to verify.`,
      confidence: 1.0,
      source: "audit",
    }),
  );
}
