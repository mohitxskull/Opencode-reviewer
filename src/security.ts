import { join } from "node:path";
import { type SecurityAdvisory, SecurityAdvisorySchema } from "./models.ts";

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
    yanked?: Array<{ package?: { name?: string; version?: string } }>;
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

export function parseCargoLockPackages(lockText: string): Array<{ name: string; version: string }> {
  const packages: Array<{ name: string; version: string }> = [];
  const blocks = lockText.replace(/\r\n/g, "\n").split(/^\[\[package\]\]\s*$/m);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i] ?? "";
    const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const versionMatch = /^version\s*=\s*"([^"]+)"/m.exec(block);
    const sourceMatch = /^source\s*=\s*"([^"]+)"/m.exec(block);
    // Only query external crates.io registry packages, not local workspace members
    if (nameMatch?.[1] && versionMatch?.[1] && sourceMatch?.[1]?.includes("crates.io")) {
      packages.push({ name: nameMatch[1], version: versionMatch[1] });
    }
  }

  return packages;
}

interface OsvBatchResponse {
  results?: Array<{
    vulns?: Array<{
      id?: string;
      aliases?: string[];
      summary?: string;
      details?: string;
      references?: Array<{ url?: string }>;
      affected?: Array<{
        ranges?: Array<{
          events?: Array<{ fixed?: string }>;
        }>;
      }>;
    }>;
  }>;
}

export async function queryOsvCratesBatch(
  packages: ReadonlyArray<{ name: string; version: string }>,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<SecurityAdvisory[]> {
  if (packages.length === 0) {
    return [];
  }

  const advisories: SecurityAdvisory[] = [];
  const seen = new Set<string>();
  const batchSize = 100;

  for (let offset = 0; offset < packages.length; offset += batchSize) {
    const chunk = packages.slice(offset, offset + batchSize);
    const queries = chunk.map((pkg) => ({
      package: { name: pkg.name, ecosystem: "crates.io" },
      version: pkg.version,
    }));

    try {
      const response = await fetchFn("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as OsvBatchResponse;
      const results = payload.results ?? [];
      for (let i = 0; i < results.length; i++) {
        const pkg = chunk[i];
        const vulns = results[i]?.vulns ?? [];
        if (!pkg || vulns.length === 0) {
          continue;
        }
        for (const vuln of vulns) {
          if (!vuln.id) {
            continue;
          }
          const key = `${vuln.id}:${pkg.name}:${pkg.version}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          const fixedVersions: string[] = [];
          for (const aff of vuln.affected ?? []) {
            for (const range of aff.ranges ?? []) {
              for (const ev of range.events ?? []) {
                if (ev.fixed) {
                  fixedVersions.push(`>=${ev.fixed}`);
                }
              }
            }
          }

          advisories.push(
            SecurityAdvisorySchema.parse({
              id: vuln.id,
              aliases: vuln.aliases ?? [],
              packageName: pkg.name,
              packageVersion: pkg.version,
              kind: "vulnerability",
              title: vuln.summary ?? vuln.id,
              description: vuln.details ?? "",
              url: vuln.references?.[0]?.url ?? null,
              cvss: null,
              patchedVersions: Array.from(new Set(fixedVersions)),
              affectedFunctions: [],
              source: "osv",
            }),
          );
        }
      }
    } catch {
      // Network/OSV fallback is best-effort; never crash the review
    }
  }

  return advisories;
}

// Why: LLMs have stale training cutoffs and cannot reliably enumerate CVEs or
// RustSec advisories from memory. We run `cargo audit --json` locally (falling
// back to Google's free OSV.dev batch API if `cargo-audit` is not installed) as
// deterministic Stage 3 ground truth, then pass the exact advisories into Stage 4
// so the OpenCode lenses can confirm production reachability and exploitability.
export async function collectSecurityAdvisories(
  repoRoot: string,
  options: { fetch?: typeof fetch } = {},
): Promise<SecurityAdvisory[]> {
  const lockFile = Bun.file(join(repoRoot, "Cargo.lock"));
  if (!(await lockFile.exists())) {
    return [];
  }

  try {
    const proc = Bun.spawn(["cargo", "audit", "--json"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (stdoutText.trim().startsWith("{")) {
      return parseCargoAuditJson(stdoutText);
    }
  } catch {
    // Fall through to OSV.dev batch API if `cargo-audit` is not installed
  }

  try {
    const lockText = await lockFile.text();
    const packages = parseCargoLockPackages(lockText);
    return await queryOsvCratesBatch(packages, options.fetch);
  } catch {
    return [];
  }
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
    `## Deterministic CVE / RustSec Advisories (${advisories.length} found — Confirm reachability in production code)\n` +
    lines.join("\n")
  );
}
