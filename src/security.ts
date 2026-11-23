import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScrubbedCargoEnv } from "./env.ts";
import { tryGitRawSync } from "./git.ts";
import { type SecurityAdvisory, SecurityAdvisorySchema } from "./models.ts";

export class CargoAuditMissingError extends Error {
  constructor() {
    super(
      "`cargo-audit` is required for deterministic CVE/RustSec scanning, but it is not installed. Install it with: cargo install cargo-audit",
    );
    this.name = "CargoAuditMissingError";
  }
}

interface CargoAuditAdvisoryPayload {
  id?: string;
  package?: string;
  title?: string;
  description?: string;
  url?: string | null;
  aliases?: string[];
  cvss?: string | null;
}

interface CargoAuditEntryPayload {
  advisory?: CargoAuditAdvisoryPayload;
  package?: { name?: string; version?: string };
  versions?: { patched?: string[] };
  affected?: { functions?: Record<string, string[]> };
}

interface CargoAuditRootPayload {
  vulnerabilities?: {
    list?: CargoAuditEntryPayload[];
  };
  warnings?: {
    unsound?: CargoAuditEntryPayload[];
  };
}

export function parseCargoAuditJson(rawJson: string): SecurityAdvisory[] {
  const trimmed = rawJson.trim();
  if (!trimmed.startsWith("{")) {
    return [];
  }

  let parsed: CargoAuditRootPayload;
  try {
    parsed = JSON.parse(trimmed) as CargoAuditRootPayload;
  } catch {
    return [];
  }

  const results: SecurityAdvisory[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: CargoAuditEntryPayload, kind: "vulnerability" | "unsound"): void => {
    const adv = entry.advisory;
    const pkgName = entry.package?.name ?? adv?.package;
    const pkgVersion = entry.package?.version;
    if (!adv?.id || !pkgName || !pkgVersion) {
      return;
    }
    const key = `${adv.id}:${pkgName}:${pkgVersion}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const affectedFunctions = entry.affected?.functions
      ? Object.keys(entry.affected.functions)
      : [];

    results.push(
      SecurityAdvisorySchema.parse({
        id: adv.id,
        aliases: adv.aliases ?? [],
        packageName: pkgName,
        packageVersion: pkgVersion,
        kind,
        title: adv.title ?? adv.id,
        description: adv.description ?? "",
        url: adv.url ?? null,
        cvss: adv.cvss ?? null,
        patchedVersions: entry.versions?.patched ?? [],
        affectedFunctions,
        source: "cargo-audit",
      }),
    );
  };

  for (const item of parsed.vulnerabilities?.list ?? []) {
    pushEntry(item, "vulnerability");
  }
  for (const item of parsed.warnings?.unsound ?? []) {
    pushEntry(item, "unsound");
  }

  return results;
}

export type CargoAuditRunner = (
  repoRoot: string,
  lockfilePath?: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCargoAuditRunner(
  repoRoot: string,
  lockfilePath?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = lockfilePath
    ? ["audit", "--json", "--no-fetch", "--file", lockfilePath]
    : ["audit", "--json"];
  const proc = Bun.spawn(["cargo", ...args], {
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

function advisoryKey(adv: SecurityAdvisory): string {
  return `${adv.id}:${adv.packageName}:${adv.packageVersion}`;
}

// Why: LLMs have stale training cutoffs and cannot reliably enumerate CVEs or
// RustSec advisories from memory. We require `cargo audit --json` as the single
// deterministic Stage 3 ground truth — failing loud with install instructions
// if `cargo-audit` is missing. When `baseSha` is provided, we diff against
// `baseSha:Cargo.lock` so only newly introduced PR advisories are surfaced.
export async function collectSecurityAdvisories(
  repoRoot: string,
  options: { baseSha?: string; runner?: CargoAuditRunner } = {},
): Promise<SecurityAdvisory[]> {
  const lockFile = Bun.file(join(repoRoot, "Cargo.lock"));
  if (!(await lockFile.exists())) {
    return [];
  }

  const runner = options.runner ?? defaultCargoAuditRunner;
  const { stdout, stderr, exitCode } = await runner(repoRoot);

  if (!stdout.trim().startsWith("{")) {
    if (
      exitCode !== 0 &&
      /no such command:\s*`?audit`?|not found|ENOENT/i.test(`${stderr}\n${stdout}`)
    ) {
      throw new CargoAuditMissingError();
    }
    throw new Error(
      `cargo audit --json failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 300)}`,
    );
  }

  const headAdvisories = parseCargoAuditJson(stdout);
  if (headAdvisories.length === 0 || !options.baseSha) {
    return headAdvisories;
  }

  // Diff against baseSha's Cargo.lock so pre-existing repo CVEs don't spam unrelated PRs
  const baseLock = tryGitRawSync(repoRoot, ["show", `${options.baseSha}:Cargo.lock`]);
  if (!baseLock.ok || baseLock.stdout.trim().length === 0) {
    return headAdvisories;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "peer-base-lock-"));
  try {
    const baseLockPath = join(tmpDir, "Cargo.lock");
    await writeFile(baseLockPath, baseLock.stdout);
    const baseRun = await runner(repoRoot, baseLockPath);
    if (baseRun.stdout.trim().startsWith("{")) {
      const baseKeys = new Set(parseCargoAuditJson(baseRun.stdout).map(advisoryKey));
      return headAdvisories.filter((adv) => !baseKeys.has(advisoryKey(adv)));
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  return headAdvisories;
}

export function formatSecurityAdvisoriesPromptSection(
  advisories: readonly SecurityAdvisory[],
): string {
  if (advisories.length === 0) {
    return "";
  }

  const lines = advisories.map((adv) => {
    const aliasStr = adv.aliases.length > 0 ? ` (${adv.aliases.join(", ")})` : "";
    const patchedStr =
      adv.patchedVersions.length > 0
        ? ` | patched: ${adv.patchedVersions.join(", ")}`
        : " | patched: none";
    const fnStr =
      adv.affectedFunctions.length > 0
        ? ` | affected fns: ${adv.affectedFunctions.slice(0, 4).join(", ")}`
        : "";
    return `- [${adv.kind.toUpperCase()}] \`${adv.id}\`${aliasStr} in \`${adv.packageName} ${adv.packageVersion}\`: ${adv.title}${patchedStr}${fnStr}`;
  });

  return (
    `## Deterministic CVE / RustSec Advisories (${advisories.length} new in PR — Confirm reachability in production code)\n` +
    lines.join("\n")
  );
}
