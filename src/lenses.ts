import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditLogger } from "./audit.ts";
import { resolvePeerReviewsDir } from "./git.ts";
import {
  type ConsideredAndRejectedItem,
  ConsideredAndRejectedItemSchema,
  type DeletionProposedItem,
  DeletionProposedItemSchema,
  type DiffFileMap,
  type Finding,
  FindingSchema,
  type FindingSource,
  type OpenQuestionItem,
  OpenQuestionItemSchema,
  type WalkthroughReport,
  WalkthroughReportSchema,
} from "./models.ts";
import {
  createDefaultOpenCodeClient,
  type ModelSpec,
  type OpenCodeClientLike,
  OpenCodeProviderQuotaError,
  parseModelSpec,
} from "./opencode/client.ts";
import {
  READONLY_SESSION_PERMISSIONS,
  type SessionPermissionRule,
} from "./opencode/permissions.ts";
import { groupDiffFilesIntoCohorts } from "./prompts/cohorts.ts";
import {
  buildReviewContextPrompt,
  buildWalkthroughContextPrompt,
  type ReviewContext,
} from "./prompts/context.ts";
import { parseLensFindingsOutput, parseWalkthroughOutput } from "./prompts/parser.ts";
import {
  COHORT_DEEP_AUDIT_PROMPT,
  IDIOMS_LOGIC_LENS_PROMPT,
  SOUNDNESS_CONCURRENCY_LENS_PROMPT,
  WALKTHROUGH_LENS_PROMPT,
} from "./prompts/templates.ts";

const CachedFindingsPayloadSchema = z.object({
  findings: z.array(FindingSchema),
  consideredAndRejected: z.array(ConsideredAndRejectedItemSchema).default([]),
  deletionsProposed: z.array(DeletionProposedItemSchema).default([]),
  openQuestions: z.array(OpenQuestionItemSchema).default([]),
});

async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const concurrency = Math.max(1, limit);
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < tasks.length) {
      const idx = nextIdx;
      nextIdx += 1;
      const task = tasks[idx];
      if (task) {
        results[idx] = await task();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

export const DEFAULT_SESSION_WAIT_TIMEOUT_MS = 300_000;

export interface MultiLensOrchestratorOptions {
  readonly model?: ModelSpec;
  readonly clientFactory?: () => Promise<OpenCodeClientLike>;
  readonly sessionWaitTimeoutMs?: number;
  readonly concurrencyLimit?: number;
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
  private readonly sessionWaitTimeoutMs: number;
  private readonly concurrencyLimit: number;

  constructor(options: MultiLensOrchestratorOptions = {}) {
    this.model = options.model ?? parseModelSpec();
    this.clientFactory = options.clientFactory ?? createDefaultOpenCodeClient;
    this.sessionWaitTimeoutMs = options.sessionWaitTimeoutMs ?? DEFAULT_SESSION_WAIT_TIMEOUT_MS;
    this.concurrencyLimit = Math.max(1, options.concurrencyLimit ?? 4);
  }

  public async runAllLenses(context: ReviewContext): Promise<MultiLensRunResult> {
    const client = await this.clientFactory();
    const overallContextPrompt = buildReviewContextPrompt(context);
    const walkthroughContextPrompt = buildWalkthroughContextPrompt(context);
    const cohorts = groupDiffFilesIntoCohorts(context.diffMap, context.crateGraph);
    const audit = context.auditLogger;
    const cacheDir = join(resolvePeerReviewsDir(context.repoRoot, context.pr.number), "cache");

    // For small PRs (<= 1 cohort), run the 3 standard lenses honoring `this.concurrencyLimit`
    if (cohorts.length <= 1) {
      await audit?.logEvent(
        "lenses.mode.selected",
        `  ├─ Running 3 lenses (Walkthrough, Soundness/Concurrency, Idioms/Logic, concurrency=${this.concurrencyLimit}) on ${Object.keys(context.diffMap).length} file(s)...`,
        {
          mode: "standard-3-lens",
          fileCount: Object.keys(context.diffMap).length,
          concurrencyLimit: this.concurrencyLimit,
          model: `${this.model.providerID}/${this.model.id}`,
        },
      );

      let walkthrough!: WalkthroughReport;
      let soundnessOut!: {
        findings: Finding[];
        consideredAndRejected: ConsideredAndRejectedItem[];
        deletionsProposed: DeletionProposedItem[];
        openQuestions: OpenQuestionItem[];
      };
      let idiomsOut!: {
        findings: Finding[];
        consideredAndRejected: ConsideredAndRejectedItem[];
        deletionsProposed: DeletionProposedItem[];
        openQuestions: OpenQuestionItem[];
      };

      await runWithConcurrency(
        [
          async () => {
            walkthrough = await this.runWalkthroughLens(
              client,
              context.repoRoot,
              walkthroughContextPrompt,
              cacheDir,
              context.fresh ?? false,
              audit,
            );
          },
          async () => {
            soundnessOut = await this.runFindingsLens(
              client,
              context.repoRoot,
              "peer-lens-soundness",
              SOUNDNESS_CONCURRENCY_LENS_PROMPT,
              overallContextPrompt,
              "soundness",
              Object.keys(context.diffMap),
              cacheDir,
              context.fresh ?? false,
              audit,
            );
          },
          async () => {
            idiomsOut = await this.runFindingsLens(
              client,
              context.repoRoot,
              "peer-lens-idioms",
              IDIOMS_LOGIC_LENS_PROMPT,
              overallContextPrompt,
              "idioms",
              Object.keys(context.diffMap),
              cacheDir,
              context.fresh ?? false,
              audit,
            );
          },
        ],
        this.concurrencyLimit,
      );

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

    let walkthroughPromise: Promise<WalkthroughReport> | null = null;
    if (this.concurrencyLimit > 1) {
      walkthroughPromise = this.runWalkthroughLens(
        client,
        context.repoRoot,
        walkthroughContextPrompt,
        cacheDir,
        context.fresh ?? false,
        audit,
      );
      walkthroughPromise.catch(() => {});
    }

    const cohortFindings: Finding[] = [];
    const consideredAndRejected: ConsideredAndRejectedItem[] = [];
    const deletionsProposed: DeletionProposedItem[] = [];
    const openQuestions: OpenQuestionItem[] = [];
    const failedCohorts: string[] = [];
    const concurrencyLimit = this.concurrencyLimit;

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
              cacheDir,
              context.fresh ?? false,
              audit,
            );
          } catch (err) {
            if (err instanceof OpenCodeProviderQuotaError) {
              throw err;
            }
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

    const walkthrough =
      walkthroughPromise !== null
        ? await walkthroughPromise
        : await this.runWalkthroughLens(
            client,
            context.repoRoot,
            walkthroughContextPrompt,
            cacheDir,
            context.fresh ?? false,
            audit,
          );
    return {
      walkthrough,
      findings: cohortFindings,
      consideredAndRejected,
      deletionsProposed,
      openQuestions,
      failedCohorts,
    };
  }

  private computeCacheFilePath(cacheDir: string, title: string, fullPrompt: string): string {
    const hash = createHash("sha256")
      .update(`${this.model.providerID}/${this.model.id}\n${title}\n${fullPrompt}`)
      .digest("hex")
      .slice(0, 16);
    const safeSlug = title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return join(cacheDir, `${safeSlug}-${hash}.json`);
  }

  private async writeCacheFileAtomically(cachePath: string, data: unknown): Promise<void> {
    try {
      const dir = join(cachePath, "..");
      await mkdir(dir, { recursive: true });
      const tmp = `${cachePath}.${randomUUID().slice(0, 8)}.tmp`;
      await Bun.write(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, cachePath);
    } catch {
      // Cache persistence is best-effort
    }
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

      let timerId: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          client.experimental.session.wait({
            sessionID: session.id,
          }),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => {
              reject(
                new Error(
                  `OpenCode session [${title}] timed out after ${this.sessionWaitTimeoutMs}ms`,
                ),
              );
            }, this.sessionWaitTimeoutMs);
          }),
        ]);
      } finally {
        if (timerId !== null) {
          clearTimeout(timerId);
        }
      }

      const messages = await client.message.list({
        sessionID: session.id,
        type: "assistant",
      });

      const erroredMsg = messages.data.find(
        (m) => m.error && (typeof m.error.message === "string" || typeof m.error.type === "string"),
      );
      if (erroredMsg?.error) {
        const errInfo = erroredMsg.error;
        const errType = errInfo.type ?? "provider.error";
        const errMsg = errInfo.message ?? "OpenCode provider returned an error";
        if (
          errType.includes("limit") ||
          errType.includes("quota") ||
          errType.includes("auth") ||
          errInfo.status === 429 ||
          errInfo.status === 401 ||
          errInfo.status === 403
        ) {
          throw new OpenCodeProviderQuotaError({
            errorType: errType,
            message: errMsg,
            status: errInfo.status,
            retryAfterMs: errInfo.retryAfterMs,
          });
        }
        throw new Error(`OpenCode session [${title}] failed (${errType}): ${errMsg}`);
      }

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
    cacheDir: string,
    bypassCache: boolean,
    audit?: AuditLogger,
  ): Promise<WalkthroughReport> {
    const fullPrompt = `${WALKTHROUGH_LENS_PROMPT}\n\n${contextPrompt}`;
    const cachePath = this.computeCacheFilePath(cacheDir, "peer-lens-walkthrough", fullPrompt);
    const cacheFile = Bun.file(cachePath);
    if (!bypassCache && (await cacheFile.exists())) {
      try {
        const cachedRaw: unknown = await cacheFile.json();
        const cachedParsed = WalkthroughReportSchema.parse(cachedRaw);
        await audit?.logEvent(
          "lens.session.cache_hit",
          `  ├─ ⚡ Cache hit for [peer-lens-walkthrough] (${cachedParsed.changes.length} files summarized)`,
          { title: "peer-lens-walkthrough", cachePath },
        );
        return cachedParsed;
      } catch {
        // Ignore corrupt cache file and re-run lens
      }
    }

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
        const parsed = parseWalkthroughOutput(replyText);
        await this.writeCacheFileAtomically(cachePath, parsed);

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
        if (err instanceof OpenCodeProviderQuotaError) {
          throw err;
        }
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
    cacheDir: string,
    bypassCache: boolean,
    audit?: AuditLogger,
  ): Promise<{
    findings: Finding[];
    consideredAndRejected: ConsideredAndRejectedItem[];
    deletionsProposed: DeletionProposedItem[];
    openQuestions: OpenQuestionItem[];
  }> {
    const fullPrompt = `${lensPrompt}\n\n${contextPrompt}`;
    const cachePath = this.computeCacheFilePath(cacheDir, title, fullPrompt);
    const cacheFile = Bun.file(cachePath);
    if (!bypassCache && (await cacheFile.exists())) {
      try {
        const cachedRaw: unknown = await cacheFile.json();
        const cachedParsed = CachedFindingsPayloadSchema.parse(cachedRaw);
        await audit?.logEvent(
          "lens.session.cache_hit",
          `  ├─ ⚡ Cache hit for [${title}] (${cachedParsed.findings.length} finding(s))`,
          { title, cachePath, findingsCount: cachedParsed.findings.length },
        );
        return cachedParsed;
      } catch {
        // Ignore corrupt cache entry and re-run lens
      }
    }

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
        const parsed = parseLensFindingsOutput(replyText);

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

        const outputPayload = {
          findings: results,
          consideredAndRejected: parsed.consideredAndRejected,
          deletionsProposed: parsed.deletionsProposed,
          openQuestions: parsed.openQuestions,
        };
        await this.writeCacheFileAtomically(cachePath, outputPayload);

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

        return outputPayload;
      } catch (err) {
        if (err instanceof OpenCodeProviderQuotaError) {
          throw err;
        }
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
