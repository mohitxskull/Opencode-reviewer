import type { DiffFileMap } from "./models.ts";

export type RustSymbolKind = "fn" | "struct" | "enum" | "trait";

export interface ModifiedRustSymbol {
  readonly name: string;
  readonly kind: RustSymbolKind;
  readonly filePath: string;
  readonly line: number;
}

export interface SymbolReferenceLocation {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
}

export interface RustSymbolGraphNode extends ModifiedRustSymbol {
  readonly prodReferences: readonly SymbolReferenceLocation[];
  readonly testReferences: readonly SymbolReferenceLocation[];
}

export interface RustSymbolGraph {
  readonly nodes: readonly RustSymbolGraphNode[];
}

const IGNORED_COMMON_RUST_NAMES = new Set([
  "new",
  "default",
  "from",
  "into",
  "try_from",
  "try_into",
  "fmt",
  "drop",
  "clone",
  "eq",
  "partial_cmp",
  "cmp",
  "hash",
  "deref",
  "deref_mut",
  "as_ref",
  "as_mut",
  "build",
  "run",
  "main",
  "test",
]);

const RUST_SYMBOL_DECL_REGEX =
  /\b(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(fn|struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

const ANNOTATED_LINE_REGEX = /^L(\d+)\s+\([+ ]\):\s*(.*)$/;

export function extractSymbolsFromFileMap(fileMap: DiffFileMap): ModifiedRustSymbol[] {
  const results: ModifiedRustSymbol[] = [];
  const seen = new Set<string>();

  for (const hunk of fileMap.hunks) {
    // 1. Check hunk header context: @@ -a,b +c,d @@ pub fn enclosing_fn(...)
    const headerMatch = RUST_SYMBOL_DECL_REGEX.exec(hunk.header);
    if (headerMatch?.[1] && headerMatch[2]) {
      const kind = headerMatch[1] as RustSymbolKind;
      const name = headerMatch[2];
      if (!IGNORED_COMMON_RUST_NAMES.has(name) && name.length >= 4 && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          kind,
          filePath: fileMap.filePath,
          line: hunk.newStart,
        });
      }
    }

    // 2. Check added/context lines inside hunk
    for (const rawLine of hunk.annotatedLines) {
      const lineMatch = ANNOTATED_LINE_REGEX.exec(rawLine);
      const lineNo = lineMatch?.[1] ? Number.parseInt(lineMatch[1], 10) : hunk.newStart;
      const code = lineMatch?.[2] ?? rawLine;

      const symMatch = RUST_SYMBOL_DECL_REGEX.exec(code);
      if (symMatch?.[1] && symMatch[2]) {
        const kind = symMatch[1] as RustSymbolKind;
        const name = symMatch[2];
        if (!IGNORED_COMMON_RUST_NAMES.has(name) && name.length >= 4 && !seen.has(name)) {
          seen.add(name);
          results.push({
            name,
            kind,
            filePath: fileMap.filePath,
            line: lineNo,
          });
        }
      }
    }
  }

  return results;
}

export function extractModifiedRustSymbols(
  diffMap: Readonly<Record<string, DiffFileMap>>,
  maxSymbols = 24,
): ModifiedRustSymbol[] {
  const all: ModifiedRustSymbol[] = [];
  const seenGlobal = new Set<string>();

  for (const fileMap of Object.values(diffMap)) {
    if (!fileMap.filePath.endsWith(".rs")) {
      continue;
    }
    for (const sym of extractSymbolsFromFileMap(fileMap)) {
      const key = `${sym.name}`;
      if (seenGlobal.has(key)) {
        continue;
      }
      seenGlobal.add(key);
      all.push(sym);
      if (all.length >= maxSymbols) {
        return all;
      }
    }
  }

  return all;
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return (
    segments.includes("tests") ||
    segments.includes("benches") ||
    normalized.endsWith("_test.rs") ||
    normalized.endsWith("/tests.rs")
  );
}

// Why: Instead of vector embeddings (which retrieve fuzzy text chunks and miss
// exact callers) or letting the LLM burn 20+ grep tool calls discovering who calls
// a modified function, we run a single batch `git grep -n -w` over `*.rs` in the
// checked-out repository to build an exact cross-workspace Call-Site & Reference
// Graph in <50ms. This immediately surfaces 0-caller dead methods (e.g. a
// state-reset method that is never invoked in production) and cross-crate callers.
export async function buildRustSymbolGraph(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  maxSymbols = 24,
): Promise<RustSymbolGraph> {
  const symbols = extractModifiedRustSymbols(diffMap, maxSymbols);
  if (symbols.length === 0) {
    return { nodes: [] };
  }

  const patternArgs: string[] = [];
  for (const sym of symbols) {
    patternArgs.push("-e", sym.name);
  }

  const proc = Bun.spawnSync(
    ["git", "grep", "-n", "-w", "--no-color", ...patternArgs, "--", "*.rs"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const prodBySymbol = new Map<string, SymbolReferenceLocation[]>();
  const testBySymbol = new Map<string, SymbolReferenceLocation[]>();
  for (const sym of symbols) {
    prodBySymbol.set(sym.name, []);
    testBySymbol.set(sym.name, []);
  }

  if (proc.exitCode === 0) {
    const output = proc.stdout.toString();
    for (const rawLine of output.split("\n")) {
      if (!rawLine) {
        continue;
      }
      const firstColon = rawLine.indexOf(":");
      if (firstColon === -1) {
        continue;
      }
      const secondColon = rawLine.indexOf(":", firstColon + 1);
      if (secondColon === -1) {
        continue;
      }

      const filePath = rawLine.slice(0, firstColon).replace(/\\/g, "/");
      const lineNo = Number.parseInt(rawLine.slice(firstColon + 1, secondColon), 10);
      const snippet = rawLine.slice(secondColon + 1).trim();
      if (!Number.isInteger(lineNo) || snippet.startsWith("//")) {
        continue;
      }

      for (const sym of symbols) {
        // Skip the defining line itself
        if (filePath === sym.filePath && Math.abs(lineNo - sym.line) <= 1) {
          continue;
        }
        // Ignore pure declaration lines matching the same symbol name
        if (
          new RegExp(`\\b(?:fn|struct|enum|trait)\\s+${sym.name}\\b`).test(snippet) &&
          filePath === sym.filePath
        ) {
          continue;
        }
        if (!new RegExp(`\\b${sym.name}\\b`).test(snippet)) {
          continue;
        }

        const ref: SymbolReferenceLocation = {
          filePath,
          line: lineNo,
          snippet: snippet.slice(0, 100),
        };
        if (isTestPath(filePath)) {
          testBySymbol.get(sym.name)?.push(ref);
        } else {
          prodBySymbol.get(sym.name)?.push(ref);
        }
      }
    }
  }

  const nodes: RustSymbolGraphNode[] = symbols.map((sym) => ({
    ...sym,
    prodReferences: prodBySymbol.get(sym.name) ?? [],
    testReferences: testBySymbol.get(sym.name) ?? [],
  }));

  return { nodes };
}

export function formatSymbolGraphSummary(graph: RustSymbolGraph): string {
  if (graph.nodes.length === 0) {
    return "No modified top-level Rust symbols indexed.";
  }

  const lines: string[] = [];
  for (const node of graph.nodes) {
    const prodCount = node.prodReferences.length;
    const testCount = node.testReferences.length;
    if (prodCount === 0) {
      lines.push(
        `- \`${node.kind} ${node.name}\` (\`${node.filePath}:${node.line}\`) -> **0 production callers/refs outside definition** (${testCount} test refs)`,
      );
    } else {
      const sampleSites = node.prodReferences
        .slice(0, 4)
        .map((r) => `\`${r.filePath}:${r.line}\``)
        .join(", ");
      const more = prodCount > 4 ? ` (+${prodCount - 4} more)` : "";
      lines.push(
        `- \`${node.kind} ${node.name}\` (\`${node.filePath}:${node.line}\`) -> ${prodCount} prod refs [${sampleSites}${more}], ${testCount} test refs`,
      );
    }
  }

  return lines.join("\n");
}
