import { describe, expect, test } from "bun:test";

import type { CrateGraph } from "../src/models.ts";
import {
  CargoGeigerMissingError,
  collectCargoGeigerReport,
  formatGeigerPromptSection,
  geigerReportToFindings,
  parseCargoGeigerJson,
} from "../src/tools/geiger.ts";

const SAMPLE_GEIGER_JSON = JSON.stringify({
  packages: [
    {
      package: { id: { name: "core-engine", version: "0.2.0" } },
      unsafety: {
        used: {
          functions: { safe: 12, unsafe_: 2 },
          exprs: { safe: 40, unsafe_: 3 },
          item_impls: { safe: 1, unsafe_: 1 },
          item_traits: { safe: 0, unsafe_: 0 },
          methods: { safe: 4, unsafe_: 0 },
        },
        unused: {
          functions: { safe: 0, unsafe_: 1 },
        },
        forbids_unsafe: false,
      },
    },
    {
      package: { id: { name: "safe-cli", version: "0.2.0" } },
      unsafety: {
        used: {
          functions: { safe: 5, unsafe_: 0 },
          exprs: { safe: 10, unsafe_: 0 },
        },
        unused: {},
        forbids_unsafe: true,
      },
    },
    {
      package: { id: { name: "libc", version: "0.2.155" } },
      unsafety: {
        used: {
          functions: { safe: 0, unsafe_: 10 },
        },
        unused: {},
        forbids_unsafe: false,
      },
    },
  ],
});

const SAMPLE_CRATE_GRAPH: CrateGraph = {
  crates: {
    "core-engine": {
      name: "core-engine",
      manifestDir: "crates/core-engine",
      layer: 0,
      dependencies: [],
    },
    "safe-cli": {
      name: "safe-cli",
      manifestDir: "crates/safe-cli",
      layer: 1,
      dependencies: ["core-engine"],
    },
  },
  testLayer: 2,
};

describe("cargo-geiger integration", () => {
  test("parses cargo geiger JSON and separates workspace vs dependency unsafe counts", () => {
    const report = parseCargoGeigerJson(SAMPLE_GEIGER_JSON, SAMPLE_CRATE_GRAPH);
    expect(report.totalWorkspaceUsedUnsafe).toBe(6);
    expect(report.packages.length).toBe(3);

    const core = report.packages.find((p) => p.packageName === "core-engine");
    expect(core?.isWorkspaceMember).toBe(true);
    expect(core?.usedUnsafe.total).toBe(6);
    expect(core?.usedUnsafe.functions).toBe(2);
    expect(core?.usedUnsafe.exprs).toBe(3);
    expect(core?.usedUnsafe.itemImpls).toBe(1);
    expect(core?.unusedUnsafeTotal).toBe(1);

    const libc = report.packages.find((p) => p.packageName === "libc");
    expect(libc?.isWorkspaceMember).toBe(false);
    expect(libc?.usedUnsafe.total).toBe(10);
  });

  test("returns null when --geiger is not enabled", async () => {
    let called = false;
    const report = await collectCargoGeigerReport("/tmp/nonexistent", {
      enabled: false,
      runner: async () => {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(report).toBeNull();
    expect(called).toBe(false);
  });

  test("throws CargoGeigerMissingError with install command when cargo-geiger is missing", async () => {
    await expect(
      collectCargoGeigerReport("/tmp/nonexistent", {
        enabled: true,
        runner: async () => ({
          stdout: "",
          stderr: "error: no such command: `geiger`",
          exitCode: 101,
        }),
      }),
    ).rejects.toThrow(CargoGeigerMissingError);
  });

  test("scopes geiger findings to modified workspace crates and resolves member Cargo.toml", () => {
    const report = parseCargoGeigerJson(SAMPLE_GEIGER_JSON, SAMPLE_CRATE_GRAPH);
    const prompt = formatGeigerPromptSection(report);
    expect(prompt).toContain("core-engine");
    expect(prompt).toContain("6 used unsafe");

    const findings = geigerReportToFindings(report, new Set(["core-engine"]), SAMPLE_CRATE_GRAPH);
    expect(findings.length).toBe(1);
    expect(findings[0]?.id).toBe("audit-geiger-core-engine");
    expect(findings[0]?.filePath).toBe("crates/core-engine/Cargo.toml");
    expect(findings[0]?.source).toBe("audit");

    const untouchedFindings = geigerReportToFindings(
      report,
      new Set(["safe-cli"]),
      SAMPLE_CRATE_GRAPH,
    );
    expect(untouchedFindings.length).toBe(0);
  });
});
