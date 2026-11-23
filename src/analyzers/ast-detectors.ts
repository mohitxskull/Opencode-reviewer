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
  // Check up to 3 lines immediately above startLine (1-based) and the line itself
  const fromIdx = Math.max(0, startLine - 4);
  const toIdx = Math.min(lines.length - 1, startLine - 1);
  for (let i = fromIdx; i <= toIdx; i++) {
    if (/\/\/\s*SAFETY\s*:/i.test(lines[i] ?? "")) {
      return true;
    }
  }
  return false;
}

export async function collectAstDeterministicFindings(
  repoRoot: string,
  diffMap: Readonly<Record<string, DiffFileMap>>,
): Promise<Finding[]> {
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

    // 1. Detect newly added `unsafe` blocks/fns/impls without a `// SAFETY:` comment
    for (const region of ast.unsafeRegions) {
      if (!addedLines.has(region.startLine) || isLineInRegions(region.startLine, ast.testRegions)) {
        continue;
      }
      if (hasSafetyCommentAbove(lines, region.startLine)) {
        continue;
      }
      const title = "New `unsafe` block/item without `// SAFETY:` invariant comment";
      const rootCause = `Undocumented unsafe region at ${relPath}:${region.startLine}`;
      const fp = computeFindingFingerprint({
        filePath: relPath,
        type: "Soundness",
        title,
        rootCause,
      });
      findings.push(
        FindingSchema.parse({
          id: `audit-ast-unsafe-${fp}`,
          filePath: relPath,
          startLine: region.startLine,
          endLine: region.startLine,
          severity: "Major",
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

    // 2. Detect newly added production panic paths (.unwrap/.expect/panic!/todo!/unimplemented!)
    // via Tree-sitter AST nodes (never fooled by string literals, URLs, or block comments).
    // Why: Grouping multiple panic calls inside the same enclosing function prevents
    // spamming N nearly identical inline comments on one function (e.g. a writer helper).
    interface PanicHit {
      readonly lineNo: number;
      readonly matchedOp: string;
      readonly isStubMacro: boolean;
    }

    const panicGroups = new Map<string, { fnName: string | null; hits: PanicHit[] }>();
    const fnSymbols = ast.symbols.filter((s) => s.kind === "fn" && !s.isTest);

    const seenPanicKey = new Set<string>();
    const sortedPanicCalls = [...ast.panicCalls].sort((a, b) => a.line - b.line);
    for (const call of sortedPanicCalls) {
      if (
        call.isTest ||
        !addedLines.has(call.line) ||
        isLineInRegions(call.line, ast.testRegions)
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

      const groupKey = enclosingFn
        ? `${enclosingFn.name}:${enclosingFn.startLine}`
        : `line:${call.line}`;
      const existing = panicGroups.get(groupKey);
      if (existing) {
        existing.hits.push({
          lineNo: call.line,
          matchedOp: call.op,
          isStubMacro: call.isStubMacro,
        });
      } else {
        panicGroups.set(groupKey, {
          fnName: enclosingFn?.name ?? null,
          hits: [{ lineNo: call.line, matchedOp: call.op, isStubMacro: call.isStubMacro }],
        });
      }
    }

    for (const group of panicGroups.values()) {
      const first = group.hits[0];
      if (!first) {
        continue;
      }
      const hasStubMacro = group.hits.some((h) => h.isStubMacro);
      const uniqueOps = Array.from(new Set(group.hits.map((h) => `\`${h.matchedOp}\``)));
      const lineList = group.hits.map((h) => `L${h.lineNo}`).join(", ");
      const isMulti = group.hits.length > 1;

      const title = isMulti
        ? `${group.hits.length} production panic calls (${uniqueOps.join(", ")}) introduced${group.fnName ? ` in \`${group.fnName}\`` : ""}`
        : `Production panic call \`${first.matchedOp}\` introduced`;
      const rootCause = isMulti
        ? `Unchecked panic operations (${group.hits.map((h) => h.matchedOp).join(", ")}) in production path ${relPath}${group.fnName ? `::${group.fnName}` : ""}`
        : `Unchecked panic operation ${first.matchedOp} in production path ${relPath}`;
      const fp = computeFindingFingerprint({
        filePath: relPath,
        type: "Bug",
        title,
        rootCause,
      });

      findings.push(
        FindingSchema.parse({
          id: `audit-ast-panic-${fp}-${first.lineNo}`,
          filePath: relPath,
          startLine: first.lineNo,
          endLine: first.lineNo,
          severity: hasStubMacro ? "Major" : "Minor",
          type: "Bug",
          epistemicState: "VERIFIED-DEFECT",
          evidenceMechanism: "Correctness",
          title,
          body: isMulti
            ? `Added ${group.hits.length} panic calls (${uniqueOps.join(", ")}) in \`${relPath}\`${group.fnName ? ` (\`${group.fnName}\`)` : ""} at ${lineList}. Propagate errors with \`?\` / \`Result\` or handle the \`None\`/\`Err\` cases explicitly.`
            : `Added \`${first.matchedOp}\` on production line \`${relPath}:${first.lineNo}\`. Propagate errors with \`?\` / \`Result\` or handle the \`None\`/\`Err\` case explicitly.`,
          rootCause,
          blastRadius: "Runtime crash / thread panic in production code",
          reversible: true,
          dependsOn: null,
          verificationCommand: "cargo test --workspace",
          traceability: `tree-sitter AST panic detector (${relPath}:${lineList})`,
          suggestion: null,
          suggestionVerified: false,
          agentPrompt: isMulti
            ? `Replace the ${group.hits.length} panic calls (${uniqueOps.join(", ")}) in \`${relPath}\` at ${lineList} with proper error propagation (\`?\` / \`Result\`) or explicit handling.`
            : `Replace \`${first.matchedOp}\` at \`${relPath}:${first.lineNo}\` with proper error propagation (\`?\` / \`Result\`) or explicit handling.`,
          confidence: 0.95,
          source: "audit",
        }),
      );
    }
  }

  return findings;
}
