import { join } from "node:path";
import { type Finding, FindingSchema } from "./models.ts";

export interface CargoCheckResult {
  readonly ok: boolean;
  readonly errorSummary: string;
}

export type CargoCheckRunner = (repoRoot: string) => Promise<CargoCheckResult>;

async function defaultCargoCheckRunner(repoRoot: string): Promise<CargoCheckResult> {
  const proc = Bun.spawnSync(
    ["cargo", "check", "--workspace", "--all-targets", "--message-format=json"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const errorMessages: string[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
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

  const ok = proc.exitCode === 0 && errorMessages.length === 0;
  const errorSummary =
    errorMessages.length > 0
      ? errorMessages.slice(0, 3).join("; ")
      : proc.stderr.toString().trim().slice(0, 300);

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

export interface SuggestionVerifierOptions {
  readonly checkRunner?: CargoCheckRunner;
}

// Why: Re-joining decoded UTF-8 lines can normalize CRLF/LF or trailing newline
// bytes, leaving the user's checked-out working tree dirty according to `git status`.
// Snapshotting `originalBytes = await Bun.file(targetPath).bytes()` and writing
// `originalBytes` back verbatim in `finally` (with SIGINT/SIGTERM deferred during
// the patch-check-restore critical section) guarantees bit-for-bit restoration.
export class SuggestionCompilerVerifier {
  private readonly checkRunner: CargoCheckRunner;

  constructor(options: SuggestionVerifierOptions = {}) {
    this.checkRunner = options.checkRunner ?? defaultCargoCheckRunner;
  }

  public async verifySuggestions(
    repoRoot: string,
    findings: readonly Finding[],
  ): Promise<Finding[]> {
    const results: Finding[] = [];

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

      const targetPath = join(repoRoot, finding.filePath);
      const targetFile = Bun.file(targetPath);
      if (!(await targetFile.exists())) {
        results.push(
          FindingSchema.parse({
            ...finding,
            suggestion: null,
            suggestionVerified: false,
          }),
        );
        continue;
      }

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

      let deferredSignal: NodeJS.Signals | null = null;
      const onSigInt = () => {
        deferredSignal = "SIGINT";
      };
      const onSigTerm = () => {
        deferredSignal = "SIGTERM";
      };

      process.on("SIGINT", onSigInt);
      process.on("SIGTERM", onSigTerm);

      let checkResult: CargoCheckResult;
      try {
        await Bun.write(targetPath, patchedText);
        checkResult = await this.checkRunner(repoRoot);
      } finally {
        await Bun.write(targetPath, originalBytes);
        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
      }

      if (deferredSignal !== null) {
        process.kill(process.pid, deferredSignal);
      }

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
