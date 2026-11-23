import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { resolvePeerStateDir, tryGitRawSync } from "./git.ts";

export class CorruptLearningStoreError extends Error {
  public readonly filePath: string;

  constructor(filePath: string, causeMessage: string) {
    super(`Corrupt repository learnings file at ${filePath}: ${causeMessage}`);
    this.name = "CorruptLearningStoreError";
    this.filePath = filePath;
  }
}

export const RepoLearningSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1),
  scope: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type RepoLearning = z.infer<typeof RepoLearningSchema>;

const LearningFilePayloadSchema = z.object({
  learnings: z.array(RepoLearningSchema),
});

export function scopeGlobMatchesFile(scopeGlob: string, filePath: string): boolean {
  const normalizedPattern = scopeGlob.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern === "*" || normalizedPattern === "**") {
    return true;
  }
  const glob = new Bun.Glob(normalizedPattern);
  if (glob.match(normalizedPath)) {
    return true;
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

// Why: Persistent repository learnings prevent the reviewer from re-litigating
// intentional architectural decisions without sending proprietary code to an
// external SaaS database. Learnings merge version-controlled `.peer/learnings.json`
// (shared team invariants) with local `.git/peer/learnings.json` (personal rules).
export class LearningStore {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  public getLearningsPath(): string {
    return join(resolvePeerStateDir(this.repoRoot), "learnings.json");
  }

  public getSharedLearningsPath(): string {
    return join(this.repoRoot, ".peer", "learnings.json");
  }

  private async readLearningsFile(path: string): Promise<RepoLearning[]> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return [];
    }
    try {
      const raw: unknown = await file.json();
      const parsed = LearningFilePayloadSchema.parse(raw);
      return parsed.learnings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CorruptLearningStoreError(path, msg);
    }
  }

  private async readSharedLearningsFromGitRef(gitRef: string): Promise<RepoLearning[]> {
    const res = tryGitRawSync(this.repoRoot, ["show", `${gitRef}:.peer/learnings.json`]);
    if (!res.ok || res.stdout.trim().length === 0) {
      return [];
    }
    try {
      const raw: unknown = JSON.parse(res.stdout);
      const parsed = LearningFilePayloadSchema.parse(raw);
      return parsed.learnings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CorruptLearningStoreError(`${gitRef}:.peer/learnings.json`, msg);
    }
  }

  public async listLocal(): Promise<RepoLearning[]> {
    return await this.readLearningsFile(this.getLearningsPath());
  }

  public async list(sharedGitRef?: string): Promise<RepoLearning[]> {
    // Why: During PR reviews, the working tree is checked out to the untrusted
    // `pr.headSha`. Reading `.peer/learnings.json` from `pr.baseSha` via `git show`
    // prevents an untrusted PR author from injecting review-suppression rules.
    const [shared, local] = await Promise.all([
      sharedGitRef
        ? this.readSharedLearningsFromGitRef(sharedGitRef)
        : this.readLearningsFile(this.getSharedLearningsPath()),
      this.listLocal(),
    ]);
    const seenIds = new Set<string>();
    const merged: RepoLearning[] = [];
    for (const item of [...shared, ...local]) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }

  public async add(input: { rule: string; scope?: string | null }): Promise<RepoLearning> {
    const existingLocal = await this.listLocal();
    const entry = RepoLearningSchema.parse({
      id: Bun.randomUUIDv7().slice(-8),
      rule: input.rule.trim(),
      scope: input.scope?.trim() || null,
      createdAt: new Date().toISOString(),
    });
    existingLocal.push(entry);
    await this.saveAllLocal(existingLocal);
    return entry;
  }

  public async remove(id: string): Promise<boolean> {
    const existingLocal = await this.listLocal();
    const filtered = existingLocal.filter((item) => item.id !== id);
    if (filtered.length === existingLocal.length) {
      return false;
    }
    await this.saveAllLocal(filtered);
    return true;
  }

  public async getMatchingLearnings(
    modifiedFiles: Iterable<string>,
    sharedGitRef?: string,
  ): Promise<RepoLearning[]> {
    const all = await this.list(sharedGitRef);
    const files = Array.from(modifiedFiles);
    return all.filter((learning) => {
      if (!learning.scope) {
        return true;
      }
      const scope = learning.scope;
      return files.some((filePath) => scopeGlobMatchesFile(scope, filePath));
    });
  }

  private async saveAllLocal(learnings: readonly RepoLearning[]): Promise<void> {
    const dir = resolvePeerStateDir(this.repoRoot);
    await mkdir(dir, { recursive: true });
    const targetPath = this.getLearningsPath();
    const tmpPath = `${targetPath}.${Bun.randomUUIDv7().slice(-8)}.tmp`;
    await Bun.write(tmpPath, JSON.stringify({ learnings }, null, 2));
    await rename(tmpPath, targetPath);
  }
}

export function formatLearningsPromptSection(learnings: readonly RepoLearning[]): string {
  if (learnings.length === 0) {
    return "";
  }
  const lines = learnings.map((l) =>
    l.scope ? `- [Scope: \`${l.scope}\`] ${l.rule}` : `- [Global] ${l.rule}`,
  );
  return (
    `## Repository Learnings & Established Invariants (Respect These; Do Not Flag As Bugs)\n` +
    lines.join("\n")
  );
}
