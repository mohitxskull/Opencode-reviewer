import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolvePeerStateDir } from "./git.ts";

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
  // Support trailing `/**` matching files anywhere beneath the prefix
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

// Why: Persistent repository learnings prevent the reviewer from re-litigating
// intentional architectural decisions (like CodeRabbit's organizational learnings)
// without sending proprietary code to an external SaaS database. Learnings live
// locally in `.git/peer/learnings.json` and filter by file path glob via `Bun.Glob`.
export class LearningStore {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  public getLearningsPath(): string {
    return join(resolvePeerStateDir(this.repoRoot), "learnings.json");
  }

  public async list(): Promise<RepoLearning[]> {
    const path = this.getLearningsPath();
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

  public async add(input: { rule: string; scope?: string | null }): Promise<RepoLearning> {
    const existing = await this.list();
    const entry = RepoLearningSchema.parse({
      id: randomUUID().slice(0, 8),
      rule: input.rule.trim(),
      scope: input.scope?.trim() || null,
      createdAt: new Date().toISOString(),
    });
    existing.push(entry);
    await this.saveAll(existing);
    return entry;
  }

  public async remove(id: string): Promise<boolean> {
    const existing = await this.list();
    const filtered = existing.filter((item) => item.id !== id);
    if (filtered.length === existing.length) {
      return false;
    }
    await this.saveAll(filtered);
    return true;
  }

  public async getMatchingLearnings(modifiedFiles: Iterable<string>): Promise<RepoLearning[]> {
    const all = await this.list();
    const files = Array.from(modifiedFiles);
    return all.filter((learning) => {
      if (!learning.scope) {
        return true;
      }
      const scope = learning.scope;
      return files.some((filePath) => scopeGlobMatchesFile(scope, filePath));
    });
  }

  private async saveAll(learnings: readonly RepoLearning[]): Promise<void> {
    const dir = resolvePeerStateDir(this.repoRoot);
    await mkdir(dir, { recursive: true });
    const targetPath = this.getLearningsPath();
    const tmpPath = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
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
