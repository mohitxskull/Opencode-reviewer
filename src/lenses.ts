import type { AuditLogger } from "./audit.ts";
import type {
  ConsideredAndRejectedItem,
  DeletionProposedItem,
  DiffFileMap,
  Finding,
  FindingSource,
  OpenQuestionItem,
  WalkthroughReport,
} from "./models.ts";
import { FindingSchema, LensFindingsOutputSchema, WalkthroughReportSchema } from "./models.ts";
import {
  createDefaultOpenCodeClient,
  type ModelSpec,
  type OpenCodeClientLike,
  parseModelSpec,
} from "./opencode/client.ts";
import {
  READONLY_SESSION_PERMISSIONS,
  type SessionPermissionRule,
} from "./opencode/permissions.ts";
import { groupDiffFilesIntoCohorts } from "./prompts/cohorts.ts";
import { buildReviewContextPrompt, type ReviewContext } from "./prompts/context.ts";
import {
  COHORT_DEEP_AUDIT_PROMPT,
  IDIOMS_LOGIC_LENS_PROMPT,
  SOUNDNESS_CONCURRENCY_LENS_PROMPT,
  WALKTHROUGH_LENS_PROMPT,
} from "./prompts/templates.ts";

export {
  createDefaultOpenCodeClient,
  type ModelSpec,
  type OpenCodeAssistantMessagePart,
  type OpenCodeClientLike,
  type OpenCodeSessionMessage,
  parseModelSpec,
} from "./opencode/client.ts";
export {
  evaluatePermissionRule,
  READONLY_SESSION_PERMISSIONS,
  type SessionPermissionRule,
} from "./opencode/permissions.ts";
export {
  DEFAULT_MAX_INLINE_DIFF_CHARS,
  DEFAULT_MAX_TIER1_FILES,
  type FileCohort,
  groupDiffFilesIntoCohorts,
  MAX_CHARS_PER_FILE_DIFF,
  MAX_HUNK_LINES_BEFORE_COMPACT,
  scoreFileReviewPriority,
} from "./prompts/cohorts.ts";
export { buildReviewContextPrompt, type ReviewContext } from "./prompts/context.ts";
export {
  COHORT_DEEP_AUDIT_PROMPT,
  IDIOMS_LOGIC_LENS_PROMPT,
  SOUNDNESS_CONCURRENCY_LENS_PROMPT,
  WALKTHROUGH_LENS_PROMPT,
} from "./prompts/templates.ts";

export class LensOutputParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LensOutputParseError";
  }
}

export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();

  // 1. Try direct JSON parse first
  try {
    const direct: unknown = JSON.parse(trimmed);
    if (typeof direct === "object" && direct !== null) {
      return direct;
    }
  } catch {
    // Continue to fenced block extraction
  }

  // 2. Try ```json ... ``` or ``` ... ``` fenced code block
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenceRegex)) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Continue searching
    }
  }

  // 3. Try outermost { ... } substring
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Fall through
    }
  }

  throw new LensOutputParseError(
    `Failed to extract valid JSON object from lens response: ${trimmed.slice(0, 200)}`,
  );
}

export interface MultiLensOrchestratorOptions {
  readonly model?: ModelSpec;
  readonly clientFactory?: () => Promise<OpenCodeClientLike>;
}

export interface MultiLensRunResult {
  readonly walkthrough: WalkthroughReport;
  readonly findings: Finding[];
  readonly consideredAndRejected?: ConsideredAndRejectedItem[];
  readonly deletionsProposed?: DeletionProposedItem[];
  readonly openQuestions?: OpenQuestionItem[];
  readonly failedCohorts?: string[];
}

export class OpenCodeMultiLensOrchestrator {
  private readonly model: ModelSpec;
  private readonly clientFactory: () => Promise<OpenCodeClientLike>;

  constructor(options: MultiLensOrchestratorOptions = {}) {
    this.model = options.model ?? parseModelSpec();
    this.clientFactory = options.clientFactory ?? createDefaultOpenCodeClient;
  }

  public async runAllLenses(context: ReviewContext): Promise<MultiLensRunResult> {
    const client = await this.clientFactory();
    const overallContextPrompt = buildReviewContextPrompt(context);
    const cohorts = groupDiffFilesIntoCohorts(context.diffMap, context.crateGraph);
    const audit = context.auditLogger;

    // For small PRs (<= 1 cohort), run the 3 standard lenses (Walkthrough + Soundness + Idioms)
    if (cohorts.length <= 1) {
      await audit?.logEvent(
        "lenses.mode.selected",
        `  ├─ Running 3 concurrent lenses (Walkthrough, Soundness/Concurrency, Idioms/Logic) on ${Object.keys(context.diffMap).length} file(s)...`,
        {
          mode: "standard-3-lens",
          fileCount: Object.keys(context.diffMap).length,
          model: `${this.model.providerID}/${this.model.id}`,
        },
      );

      const [walkthrough, soundnessOut, idiomsOut] = await Promise.all([
        this.runWalkthroughLens(client, context.repoRoot, overallContextPrompt, audit),
        this.runFindingsLens(
          client,
          context.repoRoot,
          "peer-lens-soundness",
          SOUNDNESS_CONCURRENCY_LENS_PROMPT,
          overallContextPrompt,
          "soundness",
          Object.keys(context.diffMap),
          audit,
        ),
        this.runFindingsLens(
          client,
          context.repoRoot,
          "peer-lens-idioms",
          IDIOMS_LOGIC_LENS_PROMPT,
          overallContextPrompt,
          "idioms",
          Object.keys(context.diffMap),
          audit,
        ),
      ]);

      return {
        walkthrough,
        findings: [...soundnessOut.findings, ...idiomsOut.findings],
        consideredAndRejected: [
          ...soundnessOut.consideredAndRejected,
          ...idiomsOut.consideredAndRejected,
        ],
        deletionsProposed: [...soundnessOut.deletionsProposed, ...idiomsOut.deletionsProposed],
        openQuestions: [...soundnessOut.openQuestions, ...idiomsOut.openQuestions],
      };
    }

    await audit?.logEvent(
      "lenses.mode.selected",
      `  ├─ Sharded ${Object.keys(context.diffMap).length} Rust files into ${cohorts.length} subsystem cohorts (+ Walkthrough lens)`,
      {
        mode: "sharded-cohorts",
        cohortCount: cohorts.length,
        cohorts: cohorts.map((c) => ({ id: c.id, label: c.label, files: c.filePaths })),
        model: `${this.model.providerID}/${this.model.id}`,
      },
    );

    const walkthroughPromise = this.runWalkthroughLens(
      client,
      context.repoRoot,
      overallContextPrompt,
      audit,
    );
    walkthroughPromise.catch(() => {});

    const cohortFindings: Finding[] = [];
    const consideredAndRejected: ConsideredAndRejectedItem[] = [];
    const deletionsProposed: DeletionProposedItem[] = [];
    const openQuestions: OpenQuestionItem[] = [];
    const failedCohorts: string[] = [];
    const concurrencyLimit = 4;

    for (let i = 0; i < cohorts.length; i += concurrencyLimit) {
      const batch = cohorts.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(async (cohort, batchIdx) => {
          const cohortOrdinal = i + batchIdx + 1;
          const cohortDiffMap: Record<string, DiffFileMap> = {};
          for (const fp of cohort.filePaths) {
            const fm = context.diffMap[fp];
            if (fm) {
              cohortDiffMap[fp] = fm;
            }
          }
          const cohortFileSet = new Set(cohort.filePaths);
          const cohortClippy = context.clippyDiagnostics.filter((d) =>
            cohortFileSet.has(d.filePath),
          );
          const cohortSymbolGraph = context.symbolGraph
            ? {
                nodes: context.symbolGraph.nodes.filter(
                  (n) =>
                    cohortFileSet.has(n.filePath) ||
                    n.prodReferences.some((r) => cohortFileSet.has(r.filePath)),
                ),
              }
            : undefined;

          const cohortContext: ReviewContext = {
            ...context,
            diffMap: cohortDiffMap,
            clippyDiagnostics: cohortClippy,
            symbolGraph: cohortSymbolGraph,
          };

          const cohortPrompt = buildReviewContextPrompt(
            cohortContext,
            32_000,
            cohort.filePaths.length,
          );
          const title = `peer-${cohort.id} (${cohortOrdinal}/${cohorts.length}: ${cohort.label})`;
          try {
            return await this.runFindingsLens(
              client,
              context.repoRoot,
              title,
              COHORT_DEEP_AUDIT_PROMPT,
              cohortPrompt,
              "soundness",
              cohort.filePaths,
              audit,
            );
          } catch (err) {
            failedCohorts.push(title);
            await audit?.logEvent(
              "lens.session.failed",
              `  ├─ ⚠ Cohort [${title}] failed after retries: ${err instanceof Error ? err.message : String(err)}`,
              {
                title,
                files: cohort.filePaths,
                error: err instanceof Error ? err.message : String(err),
              },
            );
            return {
              findings: [],
              consideredAndRejected: [],
              deletionsProposed: [],
              openQuestions: [],
            };
          }
        }),
      );

      for (const res of batchResults) {
        cohortFindings.push(...res.findings);
        consideredAndRejected.push(...res.consideredAndRejected);
        deletionsProposed.push(...res.deletionsProposed);
        openQuestions.push(...res.openQuestions);
      }
    }

    const walkthrough = await walkthroughPromise;
    return {
      walkthrough,
      findings: cohortFindings,
      consideredAndRejected,
      deletionsProposed,
      openQuestions,
      failedCohorts,
    };
  }

  private async executeReadOnlyPrompt(
    client: OpenCodeClientLike,
    repoRoot: string,
    title: string,
    promptText: string,
    files: readonly string[],
    audit?: AuditLogger,
    permissions: readonly SessionPermissionRule[] = READONLY_SESSION_PERMISSIONS,
  ): Promise<{ replyText: string; sessionID: string; durationMs: number; assistantTurns: number }> {
    const t0 = Date.now();
    const session = await client.session.create({
      location: { directory: repoRoot },
      model: this.model,
      title,
      permissions,
    });

    await audit?.logEvent(
      "lens.session.started",
      `  ├─ ▶ Starting [${title}] (${files.length} file(s), ${(promptText.length / 1024).toFixed(1)} KiB prompt)...`,
      {
        title,
        sessionID: session.id,
        files,
        promptChars: promptText.length,
        model: `${this.model.providerID}/${this.model.id}`,
      },
    );

    try {
      await client.session.prompt({
        sessionID: session.id,
        text: promptText,
      });

      await client.experimental.session.wait({
        sessionID: session.id,
      });

      const messages = await client.message.list({
        sessionID: session.id,
        type: "assistant",
      });

      const assistantTurns = messages.data.filter((m) => m.type === "assistant").length;
      const replyText = messages.data
        .flatMap((msg) => (msg.type === "assistant" && msg.content ? msg.content : []))
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");

      return {
        replyText,
        sessionID: session.id,
        durationMs: Date.now() - t0,
        assistantTurns,
      };
    } finally {
      try {
        await client.session.remove({ sessionID: session.id });
      } catch {
        // Ignore session removal cleanup errors
      }
    }
  }

  private async runWalkthroughLens(
    client: OpenCodeClientLike,
    repoRoot: string,
    contextPrompt: string,
    audit?: AuditLogger,
  ): Promise<WalkthroughReport> {
    const fullPrompt = `${WALKTHROUGH_LENS_PROMPT}\n\n${contextPrompt}`;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { replyText, sessionID, durationMs, assistantTurns } = await this.executeReadOnlyPrompt(
        client,
        repoRoot,
        "peer-lens-walkthrough",
        fullPrompt,
        [],
        audit,
      );

      try {
        const jsonObj = extractJsonObject(replyText);
        const parsed = WalkthroughReportSchema.parse(jsonObj);

        await audit?.logEvent(
          "lens.session.completed",
          `  ├─ ✓ Finished [peer-lens-walkthrough] in ${(durationMs / 1000).toFixed(1)}s (effort=${parsed.triage.reviewEffort}/5, risk=${parsed.triage.mergeRisk}, ${parsed.changes.length} files summarized)`,
          {
            title: "peer-lens-walkthrough",
            sessionID,
            durationMs,
            assistantTurns,
            replyChars: replyText.length,
            reviewEffort: parsed.triage.reviewEffort,
            mergeRisk: parsed.triage.mergeRisk,
            changesCount: parsed.changes.length,
          },
        );

        return parsed;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await audit?.logEvent(
            "lens.session.retry",
            `  ├─ ⟳ Retrying [peer-lens-walkthrough] after empty/unparseable response (attempt 2/2)...`,
            {
              title: "peer-lens-walkthrough",
              sessionID,
              replyPreview: replyText.slice(0, 200),
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runFindingsLens(
    client: OpenCodeClientLike,
    repoRoot: string,
    title: string,
    lensPrompt: string,
    contextPrompt: string,
    source: FindingSource,
    files: readonly string[],
    audit?: AuditLogger,
  ): Promise<{
    findings: Finding[];
    consideredAndRejected: ConsideredAndRejectedItem[];
    deletionsProposed: DeletionProposedItem[];
    openQuestions: OpenQuestionItem[];
  }> {
    const fullPrompt = `${lensPrompt}\n\n${contextPrompt}`;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { replyText, sessionID, durationMs, assistantTurns } = await this.executeReadOnlyPrompt(
        client,
        repoRoot,
        title,
        fullPrompt,
        files,
        audit,
        READONLY_SESSION_PERMISSIONS,
      );

      try {
        const jsonObj = extractJsonObject(replyText);
        const parsed = LensFindingsOutputSchema.parse(jsonObj);

        const results: Finding[] = [];
        for (let i = 0; i < parsed.findings.length; i++) {
          const item = parsed.findings[i];
          if (!item) {
            continue;
          }
          const startLine = Math.min(item.startLine, item.endLine);
          const endLine = Math.max(item.startLine, item.endLine);
          results.push(
            FindingSchema.parse({
              id: `${source}-${title.replace(/[^a-z0-9]+/gi, "-")}-${i + 1}`,
              filePath: item.filePath.replace(/\\/g, "/").replace(/^\.\//, ""),
              startLine,
              endLine,
              severity: item.severity,
              type: item.type,
              epistemicState: item.epistemicState,
              evidenceMechanism: item.evidenceMechanism,
              title: item.title,
              body: item.body,
              rootCause: item.rootCause || item.title,
              blastRadius: item.blastRadius,
              reversible: item.reversible,
              dependsOn: item.dependsOn,
              verificationCommand: item.verificationCommand,
              traceability: item.traceability,
              suggestion: item.suggestion,
              suggestionVerified: false,
              agentPrompt: item.agentPrompt,
              confidence: item.confidence,
              source,
            }),
          );
        }

        await audit?.logEvent(
          "lens.session.completed",
          `  ├─ ✓ Finished [${title}] in ${(durationMs / 1000).toFixed(1)}s (${results.length} finding(s), ${parsed.consideredAndRejected.length} rejected, ${assistantTurns} turn(s))`,
          {
            title,
            sessionID,
            durationMs,
            assistantTurns,
            files,
            findingsCount: results.length,
            consideredAndRejectedCount: parsed.consideredAndRejected.length,
            deletionsProposedCount: parsed.deletionsProposed.length,
            openQuestionsCount: parsed.openQuestions.length,
            findings: results.map((f) => ({
              id: f.id,
              filePath: f.filePath,
              startLine: f.startLine,
              endLine: f.endLine,
              severity: f.severity,
              type: f.type,
              epistemicState: f.epistemicState,
              evidenceMechanism: f.evidenceMechanism,
              title: f.title,
              rootCause: f.rootCause,
              hasSuggestion: f.suggestion !== null,
            })),
          },
        );

        return {
          findings: results,
          consideredAndRejected: parsed.consideredAndRejected,
          deletionsProposed: parsed.deletionsProposed,
          openQuestions: parsed.openQuestions,
        };
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await audit?.logEvent(
            "lens.session.retry",
            `  ├─ ⟳ Retrying [${title}] after empty/unparseable response (attempt 2/2)...`,
            {
              title,
              sessionID,
              replyPreview: replyText.slice(0, 200),
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
