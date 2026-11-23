import treeSitterRustWasm from "tree-sitter-rust/tree-sitter-rust.wasm" with { type: "file" };
import { Language, type Node as SyntaxNode, Parser } from "web-tree-sitter";
import webTreeSitterWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };

export type RustAstSymbolKind = "fn" | "struct" | "enum" | "trait";

export interface RustAstSymbol {
  readonly name: string;
  readonly kind: RustAstSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly isPublic: boolean;
  readonly isUnsafe: boolean;
  readonly isTest: boolean;
}

export interface RustLineRegion {
  readonly startLine: number;
  readonly endLine: number;
}

export interface RustAstPanicCall {
  readonly line: number;
  readonly op: string;
  readonly isStubMacro: boolean;
  readonly isTest: boolean;
}

export interface RustAstAnalysis {
  readonly symbols: readonly RustAstSymbol[];
  readonly testRegions: readonly RustLineRegion[];
  readonly unsafeRegions: readonly RustLineRegion[];
  readonly panicCalls: readonly RustAstPanicCall[];
}

let parserPromise: Promise<Parser> | null = null;

async function getRustParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      // Why: Using Bun static `with { type: "file" }` asset imports embeds both
      // WASM binaries inside `bun build --compile` executables so `peer` works
      // standalone without `node_modules/` at runtime.
      await Parser.init({
        locateFile: () => webTreeSitterWasm,
      });
      const rustLang = await Language.load(treeSitterRustWasm);
      const parser = new Parser();
      parser.setLanguage(rustLang);
      return parser;
    })().catch((err) => {
      parserPromise = null;
      throw err;
    });
  }
  return parserPromise;
}

function hasAttributeMatching(node: SyntaxNode, pattern: RegExp): boolean {
  let prev = node.previousNamedSibling;
  while (
    prev &&
    (prev.type === "attribute_item" ||
      prev.type === "line_comment" ||
      prev.type === "block_comment")
  ) {
    if (prev.type === "attribute_item" && pattern.test(prev.text)) {
      return true;
    }
    prev = prev.previousNamedSibling;
  }
  return false;
}

function isPublicNode(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "visibility_modifier") {
      return true;
    }
  }
  return false;
}

function hasUnsafeModifier(node: SyntaxNode): boolean {
  if (node.type === "unsafe_block") {
    return true;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }
    if (child.type === "unsafe") {
      return true;
    }
    if (child.type === "function_modifiers" && /\bunsafe\b/.test(child.text)) {
      return true;
    }
  }
  return false;
}

// Anchor strictly to attribute syntax so #[serde(rename = "test")] or #[doc = "test"] never match,
// while supporting #[cfg(test)], #[cfg(all(..., test, ...))], and #[tokio::test].
const TEST_ATTR_REGEX =
  /^#!?\[\s*(?:cfg\s*\(\s*(?:test|(?:all|any)\s*\([^)]*\btest\b[^)]*\))\s*\)|(?:[A-Za-z_]\w*::)*test(?:\s*\([^)]*\))?)\s*\]$/;

// Why: Regexes miss methods whose `fn` line is outside a diff hunk, get fooled
// by comments/strings, and cannot distinguish inline `#[cfg(test)] mod tests`
// callers inside `src/*.rs` from production callers. Parsing Rust files with
// `web-tree-sitter` + `tree-sitter-rust` gives exact AST symbol spans, `unsafe`
// regions, panic calls, and `#[cfg(test)]` boundaries in milliseconds with zero native addons.
export async function analyzeRustSourceAst(source: string): Promise<RustAstAnalysis> {
  const parser = await getRustParser();
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: [], testRegions: [], unsafeRegions: [], panicCalls: [] };
  }

  const symbols: RustAstSymbol[] = [];
  const testRegions: RustLineRegion[] = [];
  const unsafeRegions: RustLineRegion[] = [];
  const panicCalls: RustAstPanicCall[] = [];

  const visit = (node: SyntaxNode, inTestContext: boolean): void => {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const isTestNode = inTestContext || hasAttributeMatching(node, TEST_ATTR_REGEX);

    if (
      !inTestContext &&
      isTestNode &&
      (node.type === "mod_item" || node.type === "function_item")
    ) {
      testRegions.push({ startLine, endLine });
    }

    if (
      node.type === "unsafe_block" ||
      (node.type === "impl_item" && hasUnsafeModifier(node)) ||
      (node.type === "trait_item" && hasUnsafeModifier(node))
    ) {
      unsafeRegions.push({ startLine, endLine });
    }

    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode?.type === "field_expression") {
        const fieldNode = fnNode.childForFieldName("field");
        if (fieldNode?.text === "unwrap" || fieldNode?.text === "expect") {
          panicCalls.push({
            line: fieldNode.startPosition.row + 1,
            op: `.${fieldNode.text}()`,
            isStubMacro: false,
            isTest: isTestNode,
          });
        }
      }
    } else if (node.type === "macro_invocation") {
      const macroNode = node.childForFieldName("macro");
      const rawMacro = macroNode?.text ?? "";
      const macroName = rawMacro.split("::").pop() ?? "";
      if (macroName === "panic" || macroName === "todo" || macroName === "unimplemented") {
        panicCalls.push({
          line: (macroNode ?? node).startPosition.row + 1,
          op: `${macroName}!()`,
          isStubMacro: macroName === "todo" || macroName === "unimplemented",
          isTest: isTestNode,
        });
      }
    }

    const kindMap: Record<string, RustAstSymbolKind | undefined> = {
      function_item: "fn",
      struct_item: "struct",
      enum_item: "enum",
      trait_item: "trait",
    };

    const symKind = kindMap[node.type];
    if (symKind) {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text) {
        const isUnsafe = hasUnsafeModifier(node);
        if (isUnsafe && symKind === "fn") {
          unsafeRegions.push({ startLine, endLine });
        }
        symbols.push({
          name: nameNode.text,
          kind: symKind,
          startLine,
          endLine,
          isPublic: isPublicNode(node),
          isUnsafe,
          isTest: isTestNode,
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        visit(child, isTestNode);
      }
    }
  };

  try {
    visit(tree.rootNode, false);
  } finally {
    tree.delete();
  }

  return { symbols, testRegions, unsafeRegions, panicCalls };
}

export function isLineInRegions(line: number, regions: readonly RustLineRegion[]): boolean {
  return regions.some((r) => line >= r.startLine && line <= r.endLine);
}
