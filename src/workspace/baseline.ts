import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { computeFindingFingerprint, type Finding } from "../domain/models.ts";

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

export async function loadBaselineFingerprints(repoRoot: string): Promise<Set<string>> {
  const file = Bun.file(resolveBaselinePath(repoRoot));
  if (!(await file.exists())) {
    return new Set();
  }
  try {
    const parsed = PeerBaselineSchema.parse(await file.json());
    return new Set(parsed.fingerprints);
  } catch {
    return new Set();
  }
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
  await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`);
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
