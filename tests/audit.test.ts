import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLogger } from "../src/audit.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Streaming JSONL AuditLogger and live CLI stage progress", () => {
  test("AuditLogger appends structured JSONL events to audit.jsonl and run-<id>.jsonl and emits formatted stage progress", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-audit-test-"));
    tempDirs.push(repo);

    const progressLines: string[] = [];
    const logger = new AuditLogger({
      repoRoot: repo,
      prNumber: 23,
      runId: "test-run-001",
      onProgress: (line) => progressLines.push(line),
    });

    await logger.logEvent("run.started", "Stage 1/6: Starting review for PR #23", {
      model: "opencode/hy4-flash-free",
      profile: "assertive",
    });

    await logger.logEvent(
      "lens.session.completed",
      "  ├─ [cohort 1/4] ✓ Finished src/domain (3 findings)",
      {
        cohortId: "cohort-1",
        findingsCount: 3,
        durationMs: 1250,
      },
    );

    await logger.logEvent("run.completed", "Stage 6/6: Review complete", {
      totalFindings: 12,
    });

    expect(progressLines.length).toBe(3);
    expect(progressLines[0]).toContain("Stage 1/6: Starting review for PR #23");
    expect(progressLines[1]).toContain("[cohort 1/4] ✓ Finished src/domain (3 findings)");

    const latestAuditText = await Bun.file(logger.getLatestAuditJsonlPath()).text();
    const runAuditText = await Bun.file(logger.getRunAuditJsonlPath()).text();
    expect(latestAuditText).toBe(runAuditText);

    const parsedLines = latestAuditText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(parsedLines.length).toBe(3);
    expect(parsedLines[0]?.event).toBe("run.started");
    expect(parsedLines[0]?.runId).toBe("test-run-001");
    expect(parsedLines[0]?.prNumber).toBe(23);
    expect(parsedLines[1]?.event).toBe("lens.session.completed");
    expect((parsedLines[1]?.data as Record<string, unknown>)?.findingsCount).toBe(3);
    expect(parsedLines[2]?.event).toBe("run.completed");
  });

  test("F-05: concurrent logEvent calls on a fresh AuditLogger await shared initialization without ENOENT or truncated events", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-audit-concurrent-"));
    tempDirs.push(repo);

    const logger = new AuditLogger({
      repoRoot: repo,
      prNumber: 99,
      runId: "concurrent-run",
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        logger.logEvent(`event.${idx}`, `Concurrent event ${idx}`, { idx }),
      ),
    );

    const latestAuditText = await Bun.file(logger.getLatestAuditJsonlPath()).text();
    const lines = latestAuditText.trim().split("\n");
    expect(lines.length).toBe(12);
  });
});
