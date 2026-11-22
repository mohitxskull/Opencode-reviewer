import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

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

function scopeGlobMatchesFile(scopeGlob: string, filePath: string): boolean {
  const normalizedPattern = scopeGlob.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalizedPattern === "*" || normalizedPattern === "**") {
    return true;
  }
  const regexSource = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE_STAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE_STAR___/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexSource}$`).test(normalizedPath);
}

// Why: Persistent repository learnings prevent the reviewer from re-litigating
// intentional architectural decisions (like CodeRabbit's organizational learnings)
// without sending proprietary code to an external SaaS database. Learnings live
// locally in `.git/peer/learnings.json` and filter by file path glob.
export class LearningStore {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  public getLearningsPath(): string {
    return join(this.repoRoot, ".git", "peer", "learnings.json");
  }

  public async list(): Promise<RepoLearning[]> {
    const file = Bun.file(this.getLearningsPath());
    if (!(await file.exists())) {
      return [];
    }
    try {
      const raw: unknown = await file.json();
      const parsed = LearningFilePayloadSchema.parse(raw);
      return parsed.learnings;
    } catch {
      return [];
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
    const dir = join(this.repoRoot, ".git", "peer");
    await mkdir(dir, { recursive: true });
    await Bun.write(this.getLearningsPath(), JSON.stringify({ learnings }, null, 2));
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
