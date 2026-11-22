import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRepoReviewConfig,
  matchPathInstructionsForFiles,
  parseCodeRabbitYaml,
} from "../src/config.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const SAMPLE_CODERABBIT_YAML = `# yaml-language-server: $schema=https://www.coderabbit.ai/integrations/schema.v2.json
tone_instructions: "Act as a strict senior architecture auditor. Produce root-cause, falsifiable findings."
reviews:
  profile: assertive
  path_filters:
    - "!docs/**"
    - "!scripts/**"
  path_instructions:
    - path: "src/**/*.rs"
      instructions: |
        - Financial calculations must strictly use rust_decimal::Decimal.
        - Follow PingCAP/TiKV Rust conventions.

    - path: "src/services/live/**/*.rs"
      instructions: |
        - Concurrency safety: Never hold std::sync::Mutex or parking_lot guards across .await points.
        - Reconciliation: Unresolved orders must fetch trade history before releasing margin.

    - path: "{tests/**/*.rs,src/**/tests/**/*.rs,src/**/tests.rs}"
      instructions: |
        - Every test must name the specific break it catches.
`;

describe("Repository .coderabbit.yaml configuration and path_instructions loader", () => {
  test("parseCodeRabbitYaml extracts tone_instructions, profile, path_filters, and path_instructions", () => {
    const config = parseCodeRabbitYaml(SAMPLE_CODERABBIT_YAML);

    expect(config.toneInstructions).toContain("strict senior architecture auditor");
    expect(config.profile).toBe("assertive");
    expect(config.pathFilters).toEqual(["!docs/**", "!scripts/**"]);
    expect(config.pathInstructions.length).toBe(3);
    expect(config.pathInstructions[0]?.path).toBe("src/**/*.rs");
    expect(config.pathInstructions[1]?.path).toBe("src/services/live/**/*.rs");
  });

  test("matchPathInstructionsForFiles matches hierarchical globs and brace expansions", () => {
    const config = parseCodeRabbitYaml(SAMPLE_CODERABBIT_YAML);

    const liveMatches = matchPathInstructionsForFiles(config, [
      "src/services/live/dhan/reconciliation.rs",
    ]);
    expect(liveMatches.length).toBe(2);
    expect(liveMatches[0]?.instructions).toContain("rust_decimal::Decimal");
    expect(liveMatches[1]?.instructions).toContain("Never hold std::sync::Mutex");

    const testMatches = matchPathInstructionsForFiles(config, [
      "src/services/live/oms/tests.rs",
      "tests/oms/recovery.rs",
    ]);
    expect(testMatches.some((m) => m.instructions.includes("specific break it catches"))).toBe(
      true,
    );
  });

  test("loadRepoReviewConfig reads .coderabbit.yaml from repo root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-config-test-"));
    tempDirs.push(dir);

    await writeFile(join(dir, ".coderabbit.yaml"), SAMPLE_CODERABBIT_YAML);
    const loaded = await loadRepoReviewConfig(dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.profile).toBe("assertive");
    expect(loaded?.pathInstructions.length).toBe(3);
  });
});
