import { writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { resolveFileArchitecturalLayer } from "../analyzers/rust.ts";
import { isReviewableRustCodeFile } from "../domain/diff.ts";
import { type CrateGraph, type Finding, FindingSchema } from "../domain/models.ts";
import { buildScrubbedCargoEnv } from "../infra/env.ts";
import { parseJsonlObjects } from "../infra/jsonl.ts";
import { registerSignalCleanup } from "../infra/lifecycle.ts";
import { DEFAULT_VERIFIER_TIMEOUT_MS, runTrackedCommand } from "../infra/process.ts";
import type { AuditLogger } from "../workspace/audit-log.ts";

export interface CargoCheckResult {
  readonly ok: boolean;
  readonly errorSummary: string;
  readonly errorMessages?: readonly string[];
}

export type CargoCheckRunner = (
  repoRoot: string,
  packageName?: string,
) => Promise<CargoCheckResult>;

async function defaultCargoCheckRunner(
  repoRoot: string,
  packageName?: string,
  timeoutMs = DEFAULT_VERIFIER_TIMEOUT_MS,
): Promise<CargoCheckResult> {
  const args = packageName
    ? ["cargo", "check", "-p", packageName, "--all-targets", "--message-format=json"]
    : ["cargo", "check", "--workspace", "--all-targets", "--message-format=json"];

  const {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    timedOut,
  } = await runTrackedCommand(args, {
    cwd: repoRoot,
    env: buildScrubbedCargoEnv(),
    timeoutMs,
  });

  if (timedOut) {
    return {
      ok: false,
      errorSummary:
        stderrText.trim() || `cargo check timed out after ${Math.round(timeoutMs / 1000)}s`,
      errorMessages: [],
    };
  }

  const errorMessages: string[] = [];
  for (const parsed of parseJsonlObjects<{
    reason?: string;
    message?: { level?: string; message?: string; code?: { code?: string } | null };
  }>(stdoutText)) {
    if (parsed.reason === "compiler-message" && parsed.message?.level === "error") {
      const codePrefix = parsed.message.code?.code ? `[${parsed.message.code.code}] ` : "";
      errorMessages.push(`${codePrefix}${parsed.message.message ?? "compiler error"}`);
    }
  }

  const ok = exitCode === 0 && errorMessages.length === 0;
  const errorSummary =
    errorMessages.length > 0
      ? errorMessages.slice(0, 3).join("; ")
      : stderrText.trim().slice(0, 300);

  return { ok, errorSummary, errorMessages };
}

function applyLineReplacement(
  originalText: string,
  startLine: number,
  endLine: number,
  suggestionText: string,
): string | null {
  const lineEnding = originalText.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = originalText.endsWith("\n");
  const rawLines = originalText.replace(/\r\n/g, "\n").split("\n");
  if (hasTrailingNewline && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  if (startLine < 1 || endLine < startLine || endLine > rawLines.length) {
    return null;
  }

  const cleanedSuggestion = suggestionText.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const replacementLines = cleanedSuggestion.split("\n");

  const updatedLines = [
    ...rawLines.slice(0, startLine - 1),
    ...replacementLines,
    ...rawLines.slice(endLine),
  ];

  const joined = updatedLines.join(lineEnding);
  return hasTrailingNewline ? `${joined}${lineEnding}` : joined;
}

async function resolveContainedTargetPath(
  realRepoRoot: string,
  candidateRelPath: string,
): Promise<string | null> {
  if (!candidateRelPath || isAbsolute(candidateRelPath)) {
    return null;
  }
  const normalizedRel = candidateRelPath.replace(/\\/g, "/");
  if (normalizedRel.split("/").includes("..")) {
    return null;
  }

  const resolvedCandidate = resolve(realRepoRoot, candidateRelPath);
  if (!resolvedCandidate.startsWith(`${realRepoRoot}${sep}`)) {
    return null;
  }

  try {
    const stat = await lstat(resolvedCandidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    const realTarget = await realpath(resolvedCandidate);
    if (!realTarget.startsWith(`${realRepoRoot}${sep}`)) {
      return null;
    }
    const canonicalRel = relative(realRepoRoot, realTarget).replace(/\\/g, "/");
    if (!isReviewableRustCodeFile(canonicalRel)) {
      return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}

export interface SuggestionVerifierOptions {
  readonly checkRunner?: CargoCheckRunner;
}

// Why: Re-joining decoded UTF-8 lines can normalize CRLF/LF or trailing newline
// bytes, leaving the user's checked-out working tree dirty according to `git status`.
// Snapshotting `originalBytes = await Bun.file(targetPath).bytes()` and writing
// `originalBytes` back verbatim in `finally` (and registering a LIFO signal cleanup
// via `registerSignalCleanup` during the patch-check-restore critical section)
// guarantees bit-for-bit restoration before any branch switch.
export class SuggestionCompilerVerifier {
  private readonly checkRunner: CargoCheckRunner;

  constructor(options: SuggestionVerifierOptions = {}) {
    this.checkRunner = options.checkRunner ?? defaultCargoCheckRunner;
  }

  public async verifySuggestions(
    repoRoot: string,
    findings: readonly Finding[],
    auditLogger?: AuditLogger,
    options: {
      readonly crateGraph?: CrateGraph;
      readonly baselineErrorCount?: number;
    } = {},
  ): Promise<Finding[]> {
    const results: Finding[] = [];
    const realRepoRoot = await realpath(repoRoot);
    const totalWithSuggestions = findings.filter(
      (f) => f.suggestion !== null && f.suggestion.trim().length > 0,
    ).length;
    let suggestionIndex = 0;

    // If the baseline already has compile errors, snapshot the baseline error counts per crate
    // so we still verify suggestions and reject those introducing NEW errors or increasing counts.
    const baselineErrorCache = new Map<string, Map<string, number>>();
    const getBaselineErrors = async (
      pkgKey: string,
      pkgName?: string,
    ): Promise<Map<string, number>> => {
      const cached = baselineErrorCache.get(pkgKey);
      if (cached) {
        return cached;
      }
      const baseRes = await this.checkRunner(realRepoRoot, pkgName);
      const counts = new Map<string, number>();
      for (const msg of baseRes.errorMessages ?? (baseRes.ok ? [] : [baseRes.errorSummary])) {
        counts.set(msg, (counts.get(msg) ?? 0) + 1);
      }
      baselineErrorCache.set(pkgKey, counts);
      return counts;
    };

    for (const finding of findings) {
      if (finding.suggestion === null || finding.suggestion.trim().length === 0) {
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestion: null,
            suggestionVerified: false,
          }),
        );
        continue;
      }

      suggestionIndex += 1;
      const checkStartMs = Date.now();
      const targetPath = await resolveContainedTargetPath(realRepoRoot, finding.filePath);
      if (targetPath === null) {
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestion: null,
            suggestionVerified: false,
          }),
        );
        continue;
      }

      const targetFile = Bun.file(targetPath);
      const originalBytes = await targetFile.bytes();
      const originalText = new TextDecoder().decode(originalBytes);
      const patchedText = applyLineReplacement(
        originalText,
        finding.startLine,
        finding.endLine,
        finding.suggestion,
      );

      if (patchedText === null) {
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestion: null,
            suggestionVerified: false,
          }),
        );
        continue;
      }

      // Scope `cargo check` to the owning crate via `-p <crate>` when CrateGraph resolves it
      let packageName: string | undefined;
      if (options.crateGraph) {
        const layerInfo = resolveFileArchitecturalLayer(options.crateGraph, finding.filePath);
        if (options.crateGraph.crates[layerInfo.crateName]) {
          packageName = layerInfo.crateName;
        }
      }

      const baselineErrors =
        (options.baselineErrorCount ?? 0) > 0
          ? await getBaselineErrors(packageName ?? "__workspace__", packageName)
          : null;

      let restored = false;
      const restoreOriginalBytesSync = () => {
        if (restored) {
          return;
        }
        restored = true;
        writeFileSync(targetPath, originalBytes);
      };

      const unregisterSignalCleanup = registerSignalCleanup(restoreOriginalBytesSync);

      let checkResult: CargoCheckResult;
      try {
        await Bun.write(targetPath, patchedText);
        checkResult = await this.checkRunner(realRepoRoot, packageName);
      } finally {
        restoreOriginalBytesSync();
        unregisterSignalCleanup();
      }

      let passed = checkResult.ok;
      if (
        !passed &&
        baselineErrors &&
        baselineErrors.size > 0 &&
        checkResult.errorMessages &&
        checkResult.errorMessages.length > 0
      ) {
        const candidateCounts = new Map<string, number>();
        for (const msg of checkResult.errorMessages) {
          candidateCounts.set(msg, (candidateCounts.get(msg) ?? 0) + 1);
        }
        let introducedNewError = false;
        for (const [msg, count] of candidateCounts.entries()) {
          if (count > (baselineErrors.get(msg) ?? 0)) {
            introducedNewError = true;
            break;
          }
        }
        if (!introducedNewError) {
          passed = true;
        }
      }

      const checkDurationMs = Date.now() - checkStartMs;
      await auditLogger?.logEvent(
        "verifier.suggestion.checked",
        `  ├─ [cargo check ${suggestionIndex}/${totalWithSuggestions}${packageName ? ` -p ${packageName}` : ""}] ${finding.filePath}:${finding.startLine}-${finding.endLine} -> ${passed ? "✓ PASS" : `✗ FAIL (${checkResult.errorSummary.slice(0, 80)})`} (${checkDurationMs}ms)`,
        {
          findingId: finding.id,
          filePath: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          packageName: packageName ?? null,
          passed,
          durationMs: checkDurationMs,
          errorSummary: checkResult.errorSummary,
          suggestion: finding.suggestion,
        },
      );

      if (passed) {
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestionVerified: true,
          }),
        );
      } else {
        const compilerNote = checkResult.errorSummary
          ? `\nCompiler verification note: candidate single-hunk suggestion failed \`cargo check\` (${checkResult.errorSummary}).`
          : `\nCompiler verification note: candidate single-hunk suggestion failed \`cargo check\`.`;
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestion: null,
            suggestionVerified: false,
            agentPrompt: `${finding.agentPrompt}${compilerNote}`,
          }),
        );
      }
    }

    return results;
  }
}
