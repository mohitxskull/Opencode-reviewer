import { writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AuditLogger } from "./audit.ts";
import { isReviewableRustCodeFile } from "./diff.ts";
import { registerSignalCleanup } from "./lifecycle.ts";
import { type Finding, FindingSchema } from "./models.ts";

export interface CargoCheckResult {
  readonly ok: boolean;
  readonly errorSummary: string;
}

export type CargoCheckRunner = (repoRoot: string) => Promise<CargoCheckResult>;

async function defaultCargoCheckRunner(repoRoot: string): Promise<CargoCheckResult> {
  const proc = Bun.spawn(
    ["cargo", "check", "--workspace", "--all-targets", "--message-format=json"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const errorMessages: string[] = [];
  for (const line of stdoutText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as {
        reason?: string;
        message?: { level?: string; message?: string; code?: { code?: string } | null };
      };
      if (parsed.reason === "compiler-message" && parsed.message?.level === "error") {
        const codePrefix = parsed.message.code?.code ? `[${parsed.message.code.code}] ` : "";
        errorMessages.push(`${codePrefix}${parsed.message.message ?? "compiler error"}`);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  const ok = exitCode === 0 && errorMessages.length === 0;
  const errorSummary =
    errorMessages.length > 0
      ? errorMessages.slice(0, 3).join("; ")
      : stderrText.trim().slice(0, 300);

  return { ok, errorSummary };
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
  ): Promise<Finding[]> {
    const results: Finding[] = [];
    const realRepoRoot = await realpath(repoRoot);
    const totalWithSuggestions = findings.filter(
      (f) => f.suggestion !== null && f.suggestion.trim().length > 0,
    ).length;
    let suggestionIndex = 0;

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
        checkResult = await this.checkRunner(realRepoRoot);
      } finally {
        restoreOriginalBytesSync();
        unregisterSignalCleanup();
      }

      const checkDurationMs = Date.now() - checkStartMs;
      await auditLogger?.logEvent(
        "verifier.suggestion.checked",
        `  ├─ [cargo check ${suggestionIndex}/${totalWithSuggestions}] ${finding.filePath}:${finding.startLine}-${finding.endLine} -> ${checkResult.ok ? "✓ PASS" : `✗ FAIL (${checkResult.errorSummary.slice(0, 80)})`} (${checkDurationMs}ms)`,
        {
          findingId: finding.id,
          filePath: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          passed: checkResult.ok,
          durationMs: checkDurationMs,
          errorSummary: checkResult.errorSummary,
          suggestion: finding.suggestion,
        },
      );

      if (checkResult.ok) {
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
