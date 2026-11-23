import { join } from "node:path";
import { analyzeRustSourceAst, isLineInRegions, type RustAstAnalysis } from "./ast.ts";
import type { DiffFileMap } from "./models.ts";

export type RustSymbolKind = "fn" | "struct" | "enum" | "trait";

export interface ModifiedRustSymbol {
  readonly name: string;
  readonly kind: RustSymbolKind;
  readonly filePath: string;
  readonly line: number;
  readonly isPublic?: boolean;
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

function symbolKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

export function extractSymbolsFromFileMap(fileMap: DiffFileMap): ModifiedRustSymbol[] {
  const results: ModifiedRustSymbol[] = [];
  const seen = new Set<string>();

  for (const hunk of fileMap.hunks) {
    // 1. Check hunk header context: @@ -a,b +c,d @@ pub fn enclosing_fn(...)
    const headerContext = hunk.header.replace(/^@@[^@]+@@\s*/, "").trim();
    if (!headerContext.startsWith("//")) {
      const headerMatch = RUST_SYMBOL_DECL_REGEX.exec(headerContext);
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
            isPublic: /\bpub\b/.test(headerContext),
          });
        }
      }
    }

    // 2. Check added/context lines inside hunk
    for (const rawLine of hunk.annotatedLines) {
      const lineMatch = ANNOTATED_LINE_REGEX.exec(rawLine);
      const lineNo = lineMatch?.[1] ? Number.parseInt(lineMatch[1], 10) : hunk.newStart;
      const code = (lineMatch?.[2] ?? rawLine).trim();
      if (code.startsWith("//") || code.startsWith("/*") || code.startsWith("*")) {
        continue;
      }

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
            isPublic: /\bpub\b/.test(code),
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
      const key = symbolKey(sym.filePath, sym.name);
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

export async function extractModifiedRustSymbolsWithAst(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  maxSymbols = 24,
): Promise<{
  symbols: ModifiedRustSymbol[];
  astByFile: Map<string, RustAstAnalysis>;
}> {
  const all: ModifiedRustSymbol[] = [];
  const seenGlobal = new Set<string>();
  const astByFile = new Map<string, RustAstAnalysis>();

  for (const fileMap of Object.values(diffMap)) {
    if (!fileMap.filePath.endsWith(".rs")) {
      continue;
    }

    const diskFile = Bun.file(join(repoRoot, fileMap.filePath));
    let fileSymbols: ModifiedRustSymbol[] = [];

    if (await diskFile.exists()) {
      try {
        const source = await diskFile.text();
        const ast = await analyzeRustSourceAst(source);
        astByFile.set(fileMap.filePath, ast);

        for (const sym of ast.symbols) {
          if (sym.isTest || IGNORED_COMMON_RUST_NAMES.has(sym.name) || sym.name.length < 4) {
            continue;
          }
          const overlapsHunk = fileMap.hunks.some(
            (h) => sym.startLine <= h.newEnd && sym.endLine >= h.newStart,
          );
          if (overlapsHunk) {
            fileSymbols.push({
              name: sym.name,
              kind: sym.kind,
              filePath: fileMap.filePath,
              line: sym.startLine,
              isPublic: sym.isPublic,
            });
          }
        }
      } catch {
        fileSymbols = extractSymbolsFromFileMap(fileMap);
      }
    } else {
      fileSymbols = extractSymbolsFromFileMap(fileMap);
    }

    for (const sym of fileSymbols) {
      const key = symbolKey(sym.filePath, sym.name);
      if (seenGlobal.has(key)) {
        continue;
      }
      seenGlobal.add(key);
      all.push(sym);
      if (all.length >= maxSymbols) {
        return { symbols: all, astByFile };
      }
    }
  }

  return { symbols: all, astByFile };
}

// Why: Combining `tree-sitter-rust` AST symbol extraction with a single batch
// `git grep -n -w` over `*.rs` catches methods whose `fn` line is outside a
// diff hunk and classifies inline `#[cfg(test)]` callers inside `src/*.rs` as
// test references rather than production callers.
export async function buildRustSymbolGraph(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  maxSymbols = 24,
): Promise<RustSymbolGraph> {
  const { symbols, astByFile } = await extractModifiedRustSymbolsWithAst(
    repoRoot,
    diffMap,
    maxSymbols,
  );
  if (symbols.length === 0) {
    return { nodes: [] };
  }

  const uniqueNames = Array.from(new Set(symbols.map((s) => s.name)));
  const patternArgs: string[] = [];
  for (const name of uniqueNames) {
    patternArgs.push("-e", name);
  }

  const proc = Bun.spawn(["git", "grep", "-n", "-w", "--no-color", ...patternArgs, "--", "*.rs"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const prodByKey = new Map<string, SymbolReferenceLocation[]>();
  const testByKey = new Map<string, SymbolReferenceLocation[]>();
  const compiledBySymbol = symbols.map((sym) => ({
    sym,
    key: symbolKey(sym.filePath, sym.name),
    wordRegex: new RegExp(`\\b${sym.name}\\b`),
    declRegex: new RegExp(`\\b(?:fn|struct|enum|trait)\\s+${sym.name}\\b`),
  }));

  for (const entry of compiledBySymbol) {
    prodByKey.set(entry.key, []);
    testByKey.set(entry.key, []);
  }

  if (exitCode === 0) {
    for (const rawLine of stdoutText.split("\n")) {
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

      const fileAst = astByFile.get(filePath);
      const isInlineTestRef = fileAst ? isLineInRegions(lineNo, fileAst.testRegions) : false;

      for (const { sym, key, wordRegex, declRegex } of compiledBySymbol) {
        if (filePath === sym.filePath && Math.abs(lineNo - sym.line) <= 1) {
          continue;
        }
        if (filePath === sym.filePath && declRegex.test(snippet)) {
          continue;
        }
        if (!wordRegex.test(snippet)) {
          continue;
        }

        const ref: SymbolReferenceLocation = {
          filePath,
          line: lineNo,
          snippet: snippet.slice(0, 100),
        };
        if (isTestPath(filePath) || isInlineTestRef) {
          testByKey.get(key)?.push(ref);
        } else {
          prodByKey.get(key)?.push(ref);
        }
      }
    }
  }

  const nodes: RustSymbolGraphNode[] = compiledBySymbol.map(({ sym, key }) => ({
    ...sym,
    prodReferences: prodByKey.get(key) ?? [],
    testReferences: testByKey.get(key) ?? [],
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
