import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePeerWorkspaceExcluded, resolvePeerCommitDir, resolvePeerReviewsDir } from "./git.ts";

export interface AuditEventRecord {
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly runId: string;
  readonly prNumber: number;
  readonly event: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AuditLoggerOptions {
  readonly repoRoot: string;
  readonly prNumber: number;
  readonly headSha?: string;
  readonly runId?: string;
  readonly onProgress?: (formattedLine: string) => void;
}

function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  const mins = Math.floor(totalSeconds / 60);
  const secs = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(mins).padStart(2, "0")}:${secs}`;
}

// Why: Long-running multi-cohort Rust PR reviews need both real-time terminal
// visibility (so the developer sees which stage, cohort, or `cargo check`
// verification is currently executing) and an immutable, append-only JSONL audit
// trail on disk (`.git/peer/reviews/pr-<num>/audit.jsonl` and `runs/run-<id>.jsonl`)
// flushed after every event for post-mortem inspection and debugging.
export class AuditLogger {
  public readonly repoRoot: string;
  public readonly prNumber: number;
  public readonly headSha?: string;
  public readonly runId: string;
  private readonly startTimeMs: number;
  private readonly onProgress?: (formattedLine: string) => void;
  private initPromise: Promise<void> | null = null;

  constructor(options: AuditLoggerOptions) {
    this.repoRoot = options.repoRoot;
    this.prNumber = options.prNumber;
    this.headSha = options.headSha;
    this.runId =
      options.runId ??
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${Bun.randomUUIDv7().slice(-6)}`;
    this.startTimeMs = Date.now();
    this.onProgress = options.onProgress;
  }

  public getReviewDir(): string {
    return this.headSha
      ? resolvePeerCommitDir(this.repoRoot, this.prNumber, this.headSha)
      : resolvePeerReviewsDir(this.repoRoot, this.prNumber);
  }

  public getLatestAuditJsonlPath(): string {
    return join(this.getReviewDir(), "audit.jsonl");
  }

  public getRunAuditJsonlPath(): string {
    return join(this.getReviewDir(), "runs", `run-${this.runId}.jsonl`);
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (this.headSha) {
          await ensurePeerWorkspaceExcluded(this.repoRoot);
        }
        await mkdir(join(this.getReviewDir(), "runs"), { recursive: true });
        await writeFile(this.getLatestAuditJsonlPath(), "");
        await writeFile(this.getRunAuditJsonlPath(), "");
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  public async logEvent(
    event: string,
    message: string,
    data: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const now = new Date();
    const elapsedMs = Date.now() - this.startTimeMs;

    await this.ensureInitialized();

    const record: AuditEventRecord = {
      timestamp: now.toISOString(),
      elapsedMs,
      runId: this.runId,
      prNumber: this.prNumber,
      event,
      message,
      data,
    };

    const jsonLine = `${JSON.stringify(record)}\n`;
    await Promise.all([
      appendFile(this.getLatestAuditJsonlPath(), jsonLine),
      appendFile(this.getRunAuditJsonlPath(), jsonLine),
    ]);

    if (this.onProgress && message.trim().length > 0) {
      this.onProgress(`[${formatElapsed(elapsedMs)}] ${message}`);
    }
  }
}
