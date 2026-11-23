import { join } from "node:path";

import { tryGitRawSync } from "./git.ts";

export interface RepoInstruction {
  readonly source: string;
  readonly scope: string | null;
  readonly text: string;
}

const MAX_DOC_INSTRUCTION_CHARS = 4_000;

async function readRepoTextFile(
  repoRoot: string,
  relPath: string,
  gitRef?: string,
): Promise<string | null> {
  if (gitRef) {
    const res = tryGitRawSync(repoRoot, ["show", `${gitRef}:${relPath}`]);
    if (!res.ok || res.stdout.trim().length === 0) {
      return null;
    }
    return res.stdout;
  }

  const file = Bun.file(join(repoRoot, relPath));
  if (!(await file.exists())) {
    return null;
  }
  const text = await file.text();
  return text.trim().length > 0 ? text : null;
}

function matchesGlobScope(scope: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedScope = scope.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedScope) {
    return true;
  }
  const candidates = new Set<string>([normalizedScope]);
  if (normalizedScope.includes("/**/")) {
    candidates.add(normalizedScope.replace(/\/\*\*\//g, "/"));
  }
  if (normalizedScope.startsWith("**/")) {
    candidates.add(normalizedScope.slice(3));
  }
  for (const pattern of candidates) {
    try {
      const glob = new Bun.Glob(pattern);
      if (glob.match(normalizedPath)) {
        return true;
      }
    } catch {
      // Ignore malformed user glob patterns rather than crashing analysis
    }
  }
  return false;
}

export function parseCodeRabbitYamlInstructions(
  rawYaml: string,
  sourceLabel = ".coderabbit.yaml",
): RepoInstruction[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(rawYaml);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const out: RepoInstruction[] = [];

  if (typeof root.tone_instructions === "string" && root.tone_instructions.trim().length > 0) {
    out.push({
      source: `${sourceLabel} (tone_instructions)`,
      scope: null,
      text: root.tone_instructions.trim(),
    });
  }

  const reviews = root.reviews;
  if (typeof reviews === "object" && reviews !== null) {
    const pathInstructions = (reviews as Record<string, unknown>).path_instructions;
    if (Array.isArray(pathInstructions)) {
      for (const entry of pathInstructions) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const rec = entry as Record<string, unknown>;
        const path = typeof rec.path === "string" ? rec.path.trim() : "";
        const instructions = typeof rec.instructions === "string" ? rec.instructions.trim() : "";
        if (path && instructions) {
          out.push({
            source: `${sourceLabel} (path_instructions)`,
            scope: path,
            text: instructions,
          });
        }
      }
    }
  }

  return out;
}

// Why: Repository-level instructions (`.coderabbit.yaml`, `AGENTS.md`, `CLAUDE.md`)
// encode domain-specific invariants (e.g., Decimal-only money math, lock rules,
// teardown limits). Like `peer.toml`, always load them from `gitRef` (pr.baseSha)
// when reviewing a PR so an untrusted PR head cannot weaken review instructions.
export async function loadRepoInstructions(
  repoRoot: string,
  gitRef?: string,
): Promise<RepoInstruction[]> {
  const instructions: RepoInstruction[] = [];

  for (const crFile of [".coderabbit.yaml", ".coderabbit.yml"]) {
    const raw = await readRepoTextFile(repoRoot, crFile, gitRef);
    if (raw) {
      instructions.push(...parseCodeRabbitYamlInstructions(raw, crFile));
      break;
    }
  }

  for (const docFile of ["AGENTS.md", "CLAUDE.md"]) {
    const raw = await readRepoTextFile(repoRoot, docFile, gitRef);
    if (raw) {
      const trimmed = raw.trim();
      const text =
        trimmed.length > MAX_DOC_INSTRUCTION_CHARS
          ? `${trimmed.slice(0, MAX_DOC_INSTRUCTION_CHARS)}\n... (truncated; read \`${docFile}\` for full rules)`
          : trimmed;
      instructions.push({
        source: docFile,
        scope: null,
        text,
      });
    }
  }

  return instructions;
}

export function matchRepoInstructions(
  instructions: readonly RepoInstruction[],
  filePaths: Iterable<string>,
): RepoInstruction[] {
  const paths = Array.from(filePaths);
  return instructions.filter((item) => {
    if (!item.scope) {
      return true;
    }
    return paths.some((fp) => matchesGlobScope(item.scope as string, fp));
  });
}

export function formatRepoInstructionsPromptSection(
  instructions: readonly RepoInstruction[],
): string {
  if (instructions.length === 0) {
    return "";
  }
  const blocks = instructions.map((item) => {
    const scopeLabel = item.scope ? ` | scope: \`${item.scope}\`` : " | scope: global";
    return `### Source: \`${item.source}\`${scopeLabel}\n${item.text}`;
  });
  return `## Repository Review Instructions (Enforce Strictly)\n${blocks.join("\n\n")}`;
}
