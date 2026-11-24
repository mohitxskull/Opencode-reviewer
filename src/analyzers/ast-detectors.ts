import { join } from "node:path";

import {
  computeFindingFingerprint,
  type DiffFileMap,
  type Finding,
  FindingSchema,
} from "../domain/models.ts";
import { isRustTestOrBenchPath } from "../domain/paths.ts";
import { analyzeRustSourceAst, isLineInRegions } from "./ast.ts";

function extractAddedLineNumbers(fileMap: DiffFileMap): Set<number> {
  const added = new Set<number>();
  for (const hunk of fileMap.hunks) {
    for (const line of hunk.annotatedLines) {
      const m = /^L(\d+)\s+\(\+\):/.exec(line);
      if (m?.[1]) {
        added.add(Number.parseInt(m[1], 10));
      }
    }
  }
  return added;
}

function hasSafetyCommentAbove(lines: readonly string[], startLine: number): boolean {
  // Check the target line and walk backwards across contiguous comments/attributes above startLine (1-based)
  // for `// SAFETY:` or `/// # Safety` doc comments on `unsafe fn`/`unsafe trait`.
  if (/\/\/\s*SAFETY\s*:/i.test(lines[startLine - 1] ?? "")) {
    return true;
  }
  for (let i = startLine - 2; i >= Math.max(0, startLine - 20); i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (/\/\/\s*SAFETY\s*:|\/\/[/!]\s*#\s*Safety\b/i.test(trimmed)) {
      return true;
    }
    if (
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("#[") &&
      !trimmed.startsWith("*/") &&
      !trimmed.startsWith("*") &&
      trimmed.length > 0
    ) {
      break;
    }
  }
  return false;
}

function hasInlineAllowSuppression(
  lines: readonly string[],
  lineNo: number,
  detector: "unsafe" | "panic",
): boolean {
  // Check the target line and up to 2 lines immediately above for `// peer:allow(<detector>): <reason>`
  const fromIdx = Math.max(0, lineNo - 3);
  const toIdx = Math.min(lines.length - 1, lineNo - 1);
  const pattern = new RegExp(`//\\s*peer:allow\\s*\\(\\s*${detector}\\s*\\)\\s*:\\s*\\S`, "i");
  for (let i = fromIdx; i <= toIdx; i++) {
    if (pattern.test(lines[i] ?? "")) {
      return true;
    }
  }
  return false;
}

function hasPanicInvariantDocOrWhyAbove(
  lines: readonly string[],
  callLine: number,
  fnStartLine?: number,
): boolean {
  // Check up to 3 lines above the call (staying inside the enclosing function) for standard Rust
  // invariant/panic rationale comments or Clippy allow/expect attributes, and up to 12 doc-comment
  // lines immediately above the enclosing fn for `/// # Panics` or `#[expect(clippy::missing_panics_doc)]`.
  const minCallIdx = fnStartLine !== undefined ? Math.max(0, fnStartLine - 1) : 0;
  const callFrom = Math.max(minCallIdx, callLine - 4);
  const callTo = Math.min(lines.length - 1, callLine - 1);
  for (let i = callFrom; i <= callTo; i++) {
    const lineText = lines[i] ?? "";
    if (
      /\/\/[/!]?\s*(?:Why\b|Reason\s*:|INVARIANT\s*:|SAFETY\s*:|PANICS?\s*:|#\s*Panics\b)/i.test(
        lineText,
      ) ||
      /#!?\[\s*(?:allow|expect)\s*\([^)]*clippy::(?:unwrap_used|expect_used|missing_panics_doc|panicking_unwrap)\b/i.test(
        lineText,
      )
    ) {
      return true;
    }
  }
  if (fnStartLine !== undefined) {
    // Walk backwards from fnStartLine - 2 while lines are comments, doc comments, or attribute lines
    for (let i = fnStartLine - 2; i >= Math.max(0, fnStartLine - 15); i--) {
      const trimmed = (lines[i] ?? "").trim();
      if (
        /\/\/[/!]\s*#\s*Panics\b|clippy::(?:unwrap_used|expect_used|missing_panics_doc|panicking_unwrap)\b/i.test(
          trimmed,
        )
      ) {
        return true;
      }
      if (
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("#[") &&
        !trimmed.startsWith("]") &&
        !trimmed.startsWith("reason") &&
        trimmed.length > 0
      ) {
        break;
      }
    }
  }
  return false;
}

export interface AstDetectorOptions {
  readonly unsafe?: "error" | "warn" | "off";
  readonly panic?: "error" | "warn" | "off";
}

export async function collectAstDeterministicFindings(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
  options: AstDetectorOptions = {},
): Promise<Finding[]> {
  const unsafeMode = options.unsafe ?? "error";
  const panicMode = options.panic ?? "warn";
  if (unsafeMode === "off" && panicMode === "off") {
    return [];
  }
  const findings: Finding[] = [];

  for (const [relPath, fileMap] of Object.entries(diffMap)) {
    if (!relPath.endsWith(".rs") || isRustTestOrBenchPath(relPath)) {
      continue;
    }
    const addedLines = extractAddedLineNumbers(fileMap);
    if (addedLines.size === 0) {
      continue;
    }

    const diskFile = Bun.file(join(repoRoot, relPath));
    if (!(await diskFile.exists())) {
      continue;
    }

    const source = await diskFile.text();
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    let ast: Awaited<ReturnType<typeof analyzeRustSourceAst>>;
    try {
      ast = await analyzeRustSourceAst(source);
    } catch {
      continue;
    }

    const nonTestSymbols = ast.symbols.filter((s) => !s.isTest);
    const findEnclosingSymbol = (lineNo: number, onlyFns = false): string | null => {
      let best: (typeof nonTestSymbols)[number] | null = null;
      for (const sym of nonTestSymbols) {
        if (onlyFns && sym.kind !== "fn") {
          continue;
        }
        if (lineNo >= sym.startLine && lineNo <= sym.endLine) {
          if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) {
            best = sym;
          }
        }
      }
      return best?.name ?? null;
    };

    // 1. Detect newly added `unsafe` blocks/fns/impls without a `// SAFETY:` comment
    if (unsafeMode !== "off") {
      for (const region of ast.unsafeRegions) {
        if (
          !addedLines.has(region.startLine) ||
          isLineInRegions(region.startLine, ast.testRegions)
        ) {
          continue;
        }
        if (
          hasSafetyCommentAbove(lines, region.startLine) ||
          hasInlineAllowSuppression(lines, region.startLine, "unsafe")
        ) {
          continue;
        }
        const enclosingSym = findEnclosingSymbol(region.startLine) ?? "module";
        const snippet = (lines[region.startLine - 1] ?? "").trim();
        const title = "New `unsafe` block/item without `// SAFETY:` invariant comment";
        // Why: Omit line numbers from rootCause so edits above this block do not break baseline fingerprints
        const rootCause = `Undocumented unsafe region in ${relPath}::${enclosingSym}`;
        const fp = computeFindingFingerprint({
          filePath: relPath,
          type: "Soundness",
          title,
          rootCause,
          symbol: enclosingSym,
          snippet,
        });
        findings.push(
          FindingSchema.parse({
            id: `audit-ast-unsafe-${fp}`,
            filePath: relPath,
            startLine: region.startLine,
            endLine: region.startLine,
            severity: unsafeMode === "warn" ? "Minor" : "Major",
            type: "Soundness",
            epistemicState: "VERIFIED-DEFECT",
            evidenceMechanism: "Security",
            title,
            body: `Added \`unsafe\` code at \`${relPath}:${region.startLine}\` has no preceding \`// SAFETY:\` comment proving why its soundness invariants hold.`,
            rootCause,
            blastRadius: "Memory safety / Undefined Behavior boundary",
            reversible: true,
            dependsOn: null,
            verificationCommand: "cargo clippy --workspace --all-targets",
            traceability: `tree-sitter AST unsafe detector (${relPath}:${region.startLine})`,
            suggestion: null,
            suggestionVerified: false,
            agentPrompt: `Add a concrete \`// SAFETY:\` comment directly above \`${relPath}:${region.startLine}\` proving every precondition required by the \`unsafe\` operation, or replace it with safe Rust.`,
            confidence: 1.0,
            source: "audit",
          }),
        );
      }
    }

    if (panicMode === "off") {
      continue;
    }

    // 2. Detect newly added production panic paths (.unwrap/.expect/panic!/todo!/unimplemented!)
    // via Tree-sitter AST nodes (never fooled by string literals, URLs, or block comments).
    // Why: Grouping all production panic calls inside the same file into a single finding
    // prevents padding the Minor tier with N rows per file that an implementer agent has to churn through,
    // while recording every enclosing function + snippet in rootCause so baseline fingerprints
    // still invalidate whenever a new panic call is added to another function in the file.
    interface PanicHit {
      readonly lineNo: number;
      readonly matchedOp: string;
      readonly isStubMacro: boolean;
      readonly fnName: string | null;
      readonly snippet: string;
    }

    const filePanicHits: PanicHit[] = [];
    const fnSymbols = ast.symbols.filter((s) => s.kind === "fn" && !s.isTest);

    const seenPanicKey = new Set<string>();
    const sortedPanicCalls = [...ast.panicCalls].sort((a, b) => a.line - b.line);
    for (const call of sortedPanicCalls) {
      if (
        call.isTest ||
        !addedLines.has(call.line) ||
        isLineInRegions(call.line, ast.testRegions) ||
        hasInlineAllowSuppression(lines, call.line, "panic")
      ) {
        continue;
      }
      const dedupKey = `${call.line}:${call.op}`;
      if (seenPanicKey.has(dedupKey)) {
        continue;
      }
      seenPanicKey.add(dedupKey);

      let enclosingFn: (typeof fnSymbols)[number] | null = null;
      for (const sym of fnSymbols) {
        if (call.line >= sym.startLine && call.line <= sym.endLine) {
          if (
            !enclosingFn ||
            sym.endLine - sym.startLine < enclosingFn.endLine - enclosingFn.startLine
          ) {
            enclosingFn = sym;
          }
        }
      }

      // Skip documented invariant `.expect()` / `.unwrap()` calls preceded by `/// # Panics`, `// Why:`, or `// INVARIANT:`
      if (
        (call.op === ".expect()" || call.op === ".unwrap()") &&
        hasPanicInvariantDocOrWhyAbove(lines, call.line, enclosingFn?.startLine)
      ) {
        continue;
      }

      filePanicHits.push({
        lineNo: call.line,
        matchedOp: call.op,
        isStubMacro: call.isStubMacro,
        fnName: enclosingFn?.name ?? null,
        snippet: (lines[call.line - 1] ?? "").trim(),
      });
    }

    const first = filePanicHits[0];
    if (first) {
      const hasStubMacro = filePanicHits.some((h) => h.isStubMacro);
      const uniqueOps = Array.from(new Set(filePanicHits.map((h) => `\`${h.matchedOp}\``)));
      const uniqueFns = Array.from(
        new Set(filePanicHits.map((h) => h.fnName).filter((n): n is string => Boolean(n))),
      );
      const lineList = filePanicHits.map((h) => `L${h.lineNo}`).join(", ");
      const isMulti = filePanicHits.length > 1;
      const scopeLabel = uniqueFns.length > 0 ? uniqueFns.join(",") : "module";
      const fnSummary =
        uniqueFns.length === 1
          ? ` in \`${uniqueFns[0]}\``
          : uniqueFns.length > 1
            ? ` across ${uniqueFns.map((f) => `\`${f}\``).join(", ")}`
            : "";

      const title = isMulti
        ? `${filePanicHits.length} production panic calls (${uniqueOps.join(", ")}) introduced${fnSummary}`
        : `Production panic call \`${first.matchedOp}\` introduced${fnSummary}`;
      const rootCause = isMulti
        ? `Unchecked panic operations (${filePanicHits.map((h) => `${h.fnName ?? "mod"}:${h.matchedOp}`).join(", ")}) in ${relPath}::${scopeLabel}`
        : `Unchecked panic operation ${first.matchedOp} in ${relPath}::${scopeLabel} (${first.snippet})`;
      const fp = computeFindingFingerprint({
        filePath: relPath,
        type: "Bug",
        title,
        rootCause,
        symbol: scopeLabel,
        snippet: filePanicHits.map((h) => h.snippet).join(" | "),
      });

      const hitDetails = filePanicHits
        .map(
          (h) =>
            `- \`${relPath}:${h.lineNo}\`${h.fnName ? ` (\`${h.fnName}\`)` : ""}: \`${h.matchedOp}\``,
        )
        .join("\n");

      findings.push(
        FindingSchema.parse({
          id: `audit-ast-panic-${fp}-${first.lineNo}`,
          filePath: relPath,
          startLine: first.lineNo,
          endLine: first.lineNo,
          severity: panicMode === "error" || hasStubMacro ? "Major" : "Minor",
          type: "Bug",
          epistemicState: "VERIFIED-DEFECT",
          evidenceMechanism: "Correctness",
          title,
          body: isMulti
            ? `Added ${filePanicHits.length} production panic calls (${uniqueOps.join(", ")}) in \`${relPath}\`${fnSummary} at ${lineList}:\n${hitDetails}\nPropagate errors with \`?\` / \`Result\` or document the invariant with \`// Why:\` / \`/// # Panics\`.`
            : `Added \`${first.matchedOp}\` on production line \`${relPath}:${first.lineNo}\`${fnSummary}. Propagate errors with \`?\` / \`Result\` or document the invariant with \`// Why:\` / \`/// # Panics\`.`,
          rootCause,
          blastRadius: "Runtime crash / thread panic in production code",
          reversible: true,
          dependsOn: null,
          verificationCommand: "cargo test --workspace",
          traceability: `tree-sitter AST panic detector (${relPath}:${lineList})`,
          suggestion: null,
          suggestionVerified: false,
          agentPrompt: isMulti
            ? `Audit the ${filePanicHits.length} panic calls (${uniqueOps.join(", ")}) in \`${relPath}\` at ${lineList}. Replace unguarded panics with \`?\` / \`Result\` propagation, or document proven structural invariants.`
            : `Audit \`${first.matchedOp}\` at \`${relPath}:${first.lineNo}\`. Replace unguarded panic with \`?\` / \`Result\` propagation, or document the structural invariant.`,
          confidence: 0.95,
          source: "audit",
        }),
      );
    }
  }

  return findings;
}
