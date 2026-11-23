import { describe, expect, test } from "bun:test";

import { analyzeRustSourceAst, isLineInRegions } from "../src/analyzers/ast.ts";

describe("Tree-sitter Rust AST analyzer", () => {
  test("extracts enclosing impl methods, unsafe blocks, and inline #[cfg(test)] regions accurately", async () => {
    const rustCode = [
      "pub struct Engine {",
      "    pub count: usize,",
      "}",
      "",
      "impl Engine {",
      "    pub fn process_order(&mut self, qty: usize) -> usize {",
      "        // Comment with fake fn ignored_comment_fn() {}",
      "        unsafe {",
      "            self.count += qty;",
      "        }",
      "        self.count",
      "    }",
      "",
      "    fn internal_helper(&self) -> usize {",
      "        self.count",
      "    }",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "    #[test]",
      "    fn test_internal_helper() {",
      "        let e = Engine { count: 1 };",
      "        assert_eq!(e.internal_helper(), 1);",
      "    }",
      "}",
      "",
    ].join("\n");

    const ast = await analyzeRustSourceAst(rustCode);

    expect(
      ast.symbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        isPublic: s.isPublic,
        isTest: s.isTest,
      })),
    ).toEqual([
      { name: "Engine", kind: "struct", isPublic: true, isTest: false },
      { name: "process_order", kind: "fn", isPublic: true, isTest: false },
      { name: "internal_helper", kind: "fn", isPublic: false, isTest: false },
      { name: "test_internal_helper", kind: "fn", isPublic: false, isTest: true },
    ]);

    const processOrder = ast.symbols.find((s) => s.name === "process_order");
    expect(processOrder?.startLine).toBe(6);
    expect(processOrder?.endLine).toBe(12);

    // Unsafe block on lines 8-10 detected accurately
    expect(ast.unsafeRegions).toEqual([{ startLine: 8, endLine: 10 }]);

    // Inline #[cfg(test)] module (lines 19-27) detected accurately
    expect(isLineInRegions(25, ast.testRegions)).toBe(true);
    expect(isLineInRegions(9, ast.testRegions)).toBe(false);
  });

  test('F-09: TEST_ATTR_REGEX ignores #[serde(rename = "test")] and panicCalls catches URL .unwrap() while ignoring string literals', async () => {
    const rustCode = [
      '#[serde(rename = "test")]',
      "pub fn prod_fn() {",
      '    let msg = "never call .unwrap() in prod";',
      '    let _u = Url::parse("https://example.com").unwrap();',
      '    /* x.expect("block comment") */',
      "    unsafe { std::hint::unreachable_unchecked() }",
      "}",
      "",
    ].join("\n");

    const ast = await analyzeRustSourceAst(rustCode);
    const prod = ast.symbols.find((s) => s.name === "prod_fn");
    expect(prod?.isTest).toBe(false);
    expect(ast.testRegions).toEqual([]);
    expect(ast.unsafeRegions).toEqual([{ startLine: 6, endLine: 6 }]);
    // Line 4 (.unwrap() after https://) IS detected; line 3 (string) and line 5 (block comment) are NOT
    expect(ast.panicCalls).toEqual([
      { line: 4, op: ".unwrap()", isStubMacro: false, isTest: false },
    ]);
  });
});
