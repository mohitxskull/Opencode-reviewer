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

const PANIC_PATTERN = /\.(unwrap|expect)\s*\(|\b(panic|todo|unimplemented)!\s*\(/;

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
    for (const lineNo of Array.from(addedLines).sort((a, b) => a - b)) {
      if (isLineInRegions(lineNo, ast.testRegions)) {
        continue;
      }
      const lineText = (lines[lineNo - 1] ?? "").trim();
      if (lineText.startsWith("//") || lineText.startsWith("/*") || lineText.startsWith("*")) {
        continue;
      }
      const codeBeforeComment = lineText.split("//")[0] ?? "";
      const match = PANIC_PATTERN.exec(codeBeforeComment);
      if (!match) {
        continue;
      }
      const matchedOp = match[1] ? `.${match[1]}()` : `${match[2]}!()`;
      const isStubMacro = match[2] === "todo" || match[2] === "unimplemented";
      const title = `Production panic call \`${matchedOp}\` introduced`;
      const rootCause = `Unchecked panic operation ${matchedOp} in production path ${relPath}`;
      const fp = computeFindingFingerprint({
        filePath: relPath,
        type: "Bug",
        title,
        rootCause,
      });

      findings.push(
        FindingSchema.parse({
          id: `audit-ast-panic-${fp}-${lineNo}`,
          filePath: relPath,
          startLine: lineNo,
          endLine: lineNo,
          severity: isStubMacro ? "Major" : "Minor",
          type: "Bug",
          epistemicState: "VERIFIED-DEFECT",
          evidenceMechanism: "Correctness",
          title,
          body: `Added \`${matchedOp}\` on production line \`${relPath}:${lineNo}\`. Propagate errors with \`?\` / \`Result\` or handle the \`None\`/\`Err\` case explicitly.`,
          rootCause,
          blastRadius: "Runtime crash / thread panic in production code",
          reversible: true,
          dependsOn: null,
          verificationCommand: "cargo test --workspace",
          traceability: `tree-sitter AST panic detector (${relPath}:${lineNo})`,
          suggestion: null,
          suggestionVerified: false,
          agentPrompt: `Replace \`${matchedOp}\` at \`${relPath}:${lineNo}\` with proper error propagation (\`?\` / \`Result\`) or explicit handling.`,
          confidence: 0.95,
          source: "audit",
        }),
      );
    }
  }

  return findings;
}
