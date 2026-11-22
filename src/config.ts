import { join } from "node:path";
import type { ReviewProfile } from "./models.ts";

export interface PathInstructionRule {
  readonly path: string;
  readonly instructions: string;
}

export interface RepoReviewConfig {
  readonly toneInstructions: string | null;
  readonly profile: ReviewProfile | null;
  readonly pathFilters: readonly string[];
  readonly pathInstructions: readonly PathInstructionRule[];
}

function unquoteYamlString(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

export function parseCodeRabbitYaml(yamlText: string): RepoReviewConfig {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");

  let toneInstructions: string | null = null;
  let profile: ReviewProfile | null = null;
  const pathFilters: string[] = [];
  const pathInstructions: PathInstructionRule[] = [];

  let i = 0;
  let inPathFilters = false;
  let inPathInstructions = false;
  let currentPathPattern: string | null = null;
  let currentInstructionLines: string[] = [];
  let inBlockScalar = false;
  let blockScalarIndent = 0;

  const flushCurrentPathInstruction = () => {
    if (currentPathPattern && currentInstructionLines.length > 0) {
      pathInstructions.push({
        path: currentPathPattern,
        instructions: currentInstructionLines.join("\n").trim(),
      });
    }
    currentPathPattern = null;
    currentInstructionLines = [];
    inBlockScalar = false;
  };

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    const indent = rawLine.search(/\S/);

    if (inBlockScalar) {
      if (trimmed.length === 0) {
        currentInstructionLines.push("");
        i += 1;
        continue;
      }
      if (indent >= blockScalarIndent) {
        currentInstructionLines.push(rawLine.slice(blockScalarIndent));
        i += 1;
        continue;
      }
      inBlockScalar = false;
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("tone_instructions:")) {
      const val = trimmed.slice("tone_instructions:".length).trim();
      if (val.length > 0 && val !== "|") {
        toneInstructions = unquoteYamlString(val);
      }
      i += 1;
      continue;
    }

    if (trimmed.startsWith("profile:")) {
      const val = unquoteYamlString(trimmed.slice("profile:".length));
      if (val === "quiet" || val === "chill" || val === "assertive") {
        profile = val;
      }
      i += 1;
      continue;
    }

    if (trimmed === "path_filters:") {
      flushCurrentPathInstruction();
      inPathFilters = true;
      inPathInstructions = false;
      i += 1;
      continue;
    }

    if (trimmed === "path_instructions:") {
      flushCurrentPathInstruction();
      inPathFilters = false;
      inPathInstructions = true;
      i += 1;
      continue;
    }

    if (inPathFilters) {
      if (trimmed.startsWith("- ")) {
        pathFilters.push(unquoteYamlString(trimmed.slice(2)));
        i += 1;
        continue;
      }
      inPathFilters = false;
    }

    if (inPathInstructions) {
      if (trimmed.startsWith("- path:") || trimmed.startsWith("path:")) {
        flushCurrentPathInstruction();
        const afterColon = trimmed.slice(trimmed.indexOf(":") + 1);
        currentPathPattern = unquoteYamlString(afterColon);
        i += 1;
        continue;
      }

      if (trimmed.startsWith("instructions:")) {
        const afterColon = trimmed.slice("instructions:".length).trim();
        if (afterColon === "|" || afterColon === ">") {
          inBlockScalar = true;
          // Determine block scalar indent from next non-empty line
          let nextIdx = i + 1;
          while (nextIdx < lines.length && (lines[nextIdx]?.trim().length ?? 0) === 0) {
            nextIdx += 1;
          }
          const nextIndent = nextIdx < lines.length ? (lines[nextIdx]?.search(/\S/) ?? 8) : 8;
          blockScalarIndent = Math.max(nextIndent, indent + 2);
        } else if (afterColon.length > 0) {
          currentInstructionLines.push(unquoteYamlString(afterColon));
        }
        i += 1;
        continue;
      }
    }

    i += 1;
  }

  flushCurrentPathInstruction();

  return {
    toneInstructions,
    profile,
    pathFilters,
    pathInstructions,
  };
}

function expandBraceGlobs(pattern: string): string[] {
  const trimmed = pattern.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [trimmed];
}

function singleGlobMatchesPath(globPattern: string, filePath: string): boolean {
  const normGlob = globPattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normGlob === "*" || normGlob === "**") {
    return true;
  }
  const regexSource = normGlob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\?/g, ".")
    .replace(/\*\*\//g, "___GLOBSTAR_SLASH___")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR_SLASH___/g, "(?:.*/)?")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${regexSource}$`).test(normPath);
}

export function globPatternMatchesFile(pattern: string, filePath: string): boolean {
  const subPatterns = expandBraceGlobs(pattern);
  return subPatterns.some((sub) => singleGlobMatchesPath(sub, filePath));
}

export function isAllowedByPathFilters(pathFilters: readonly string[], filePath: string): boolean {
  for (const filter of pathFilters) {
    if (filter.startsWith("!")) {
      const excludedGlob = filter.slice(1).trim();
      if (globPatternMatchesFile(excludedGlob, filePath)) {
        return false;
      }
    }
  }
  return true;
}

export function matchPathInstructionsForFiles(
  config: RepoReviewConfig | null | undefined,
  filePaths: readonly string[],
): PathInstructionRule[] {
  if (!config || config.pathInstructions.length === 0) {
    return [];
  }
  return config.pathInstructions.filter((rule) =>
    filePaths.some((fp) => globPatternMatchesFile(rule.path, fp)),
  );
}

export async function loadRepoReviewConfig(repoRoot: string): Promise<RepoReviewConfig | null> {
  for (const candidateName of [".coderabbit.yaml", ".coderabbit.yml"]) {
    const file = Bun.file(join(repoRoot, candidateName));
    if (await file.exists()) {
      const content = await file.text();
      return parseCodeRabbitYaml(content);
    }
  }
  return null;
}
