import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { computeFindingFingerprint, type Finding } from "../domain/models.ts";
import { tryGitRawSync } from "./git.ts";

export class CorruptBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptBaselineError";
  }
}

export const PeerBaselineSchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.string(),
  fingerprints: z.array(z.string().min(1)).default([]),
});
export type PeerBaseline = z.infer<typeof PeerBaselineSchema>;

export function resolveBaselinePath(repoRoot: string): string {
  return join(repoRoot, ".peer", "baseline.json");
}

export function findingBaselineKey(finding: Finding): string {
  return computeFindingFingerprint(finding);
}

// Why: A PR head commit is untrusted and could edit `.peer/baseline.json` in the
// same PR to silence all CI gate findings. When `gitRef` (baseSha) is provided,
// always read `.peer/baseline.json` from the trusted base branch via `git show`.
export async function loadBaselineFingerprints(
  repoRoot: string,
  gitRef?: string,
): Promise<Set<string>> {
  let rawText: string | null = null;
  let sourceLabel = resolveBaselinePath(repoRoot);

  if (gitRef) {
    sourceLabel = `${gitRef.slice(0, 7)}:.peer/baseline.json`;
    const fromGit = tryGitRawSync(repoRoot, ["show", `${gitRef}:.peer/baseline.json`]);
    if (!fromGit.ok || fromGit.stdout.trim().length === 0) {
      return new Set();
    }
    rawText = fromGit.stdout;
  } else {
    const file = Bun.file(sourceLabel);
    if (!(await file.exists())) {
      return new Set();
    }
    rawText = await file.text();
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new CorruptBaselineError(
      `Corrupt baseline JSON at ${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = PeerBaselineSchema.safeParse(rawJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new CorruptBaselineError(`Invalid baseline schema at ${sourceLabel}: ${details}`);
  }
  return new Set(parsed.data.fingerprints);
}

export async function saveBaselineFingerprints(
  repoRoot: string,
  findings: readonly Finding[],
): Promise<string> {
  const path = resolveBaselinePath(repoRoot);
  await mkdir(join(repoRoot, ".peer"), { recursive: true });
  const fingerprints = Array.from(new Set(findings.map(findingBaselineKey))).sort();
  const payload: PeerBaseline = {
    version: 1,
    updatedAt: new Date().toISOString(),
    fingerprints,
  };
  const tmpPath = `${path}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
  await Bun.write(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmpPath, path);
  return path;
}

export function filterFindingsByBaseline(
  findings: readonly Finding[],
  baseline: ReadonlySet<string>,
): { newFindings: Finding[]; baselinedCount: number } {
  if (baseline.size === 0) {
    return { newFindings: [...findings], baselinedCount: 0 };
  }
  const newFindings: Finding[] = [];
  let baselinedCount = 0;
  for (const f of findings) {
    if (baseline.has(findingBaselineKey(f))) {
      baselinedCount += 1;
    } else {
      newFindings.push(f);
    }
  }
  return { newFindings, baselinedCount };
}
