import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CargoDenyMissingError,
  collectCargoDenyDiagnostics,
  denyDiagnosticsToFindings,
  hasCargoDenyConfig,
  parseCargoDenyJsonLines,
} from "../src/analyzers/deny.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Tool #2: cargo-deny supply-chain & policy checker", () => {
  test("parseCargoDenyJsonLines extracts license, ban, and source diagnostics and maps them to Findings", () => {
    const sampleJsonl = [
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "error",
          code: "license-not-encountered",
          message: "failed to satisfy license requirements for crate `gpl-crate`",
          notes: ["GPL-3.0 is not in the allow list"],
          graphs: [{ Krate: { name: "gpl-crate", version: "1.0.0" } }],
        },
      }),
      JSON.stringify({
        type: "diagnostic",
        fields: {
          severity: "warning",
          code: "duplicate-crate",
          message: "found 2 duplicate versions for crate `syn`",
          notes: ["syn 1.0.109 and syn 2.0.79"],
          graphs: [{ Krate: { name: "syn", version: "1.0.109" } }],
        },
      }),
    ].join("\n");

    const diags = parseCargoDenyJsonLines(sampleJsonl);
    expect(diags.length).toBe(2);
    expect(diags[0]?.code).toBe("license-not-encountered");
    expect(diags[0]?.crateName).toBe("gpl-crate");
    expect(diags[1]?.severity).toBe("warning");

    const findings = denyDiagnosticsToFindings(diags);
    expect(findings.length).toBe(2);
    expect(findings[0]?.severity).toBe("Major");
    expect(findings[0]?.verificationCommand).toBe("cargo deny check");
    expect(findings[1]?.severity).toBe("Minor");
  });

  test("collectCargoDenyDiagnostics skips when deny.toml is absent unless force=true, and throws CargoDenyMissingError when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-deny-test-"));
    tempDirs.push(dir);

    // No deny.toml and force=false -> returns [] without invoking runner
    let invoked = false;
    const skipped = await collectCargoDenyDiagnostics(dir, {
      runner: async () => {
        invoked = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(skipped).toEqual([]);
    expect(invoked).toBe(false);

    // With deny.toml present and cargo-deny missing -> throws CargoDenyMissingError
    expect(await hasCargoDenyConfig(dir)).toBe(false);
    await mkdir(join(dir, ".cargo"), { recursive: true });
    await writeFile(join(dir, ".cargo", "deny.toml"), "[bans]\nmultiple-versions = 'warn'\n");
    expect(await hasCargoDenyConfig(dir)).toBe(true);
    await rm(join(dir, ".cargo"), { recursive: true, force: true });
    await writeFile(join(dir, "deny.toml"), "[bans]\nmultiple-versions = 'warn'\n");
    expect(await hasCargoDenyConfig(dir)).toBe(true);
    await expect(
      collectCargoDenyDiagnostics(dir, {
        runner: async () => ({
          stdout: "",
          stderr: "error: no such command: `deny`",
          exitCode: 101,
        }),
      }),
    ).rejects.toThrow(CargoDenyMissingError);
  });
});
