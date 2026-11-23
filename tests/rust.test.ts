import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectClippyDiagnostics,
  collectCrateGraph,
  findSuggestedReplacementForMessage,
  resolveFileArchitecturalLayer,
} from "../src/rust.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Task 04: Rust ground-truth collector (cargo metadata & clippy)", () => {
  test("collectCrateGraph orders leaf crates before dependent crates and tests", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "peer-rust-ws-"));
    tempDirs.push(wsDir);

    await mkdir(join(wsDir, "core_crate", "src"), { recursive: true });
    await mkdir(join(wsDir, "api_crate", "src"), { recursive: true });
    await mkdir(join(wsDir, "api_crate", "tests"), { recursive: true });

    await writeFile(
      join(wsDir, "Cargo.toml"),
      `[workspace]\nresolver = "2"\nmembers = ["core_crate", "api_crate"]\n`,
    );

    await writeFile(
      join(wsDir, "core_crate", "Cargo.toml"),
      `[package]\nname = "core_crate"\nversion = "0.1.0"\nedition = "2021"\n`,
    );
    await writeFile(join(wsDir, "core_crate", "src", "lib.rs"), `pub fn core_val() -> u32 { 1 }\n`);

    await writeFile(
      join(wsDir, "api_crate", "Cargo.toml"),
      `[package]\nname = "api_crate"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ncore_crate = { path = "../core_crate" }\n`,
    );
    await writeFile(
      join(wsDir, "api_crate", "src", "lib.rs"),
      `pub fn api_val() -> u32 { core_crate::core_val() + 1 }\n`,
    );
    await writeFile(
      join(wsDir, "api_crate", "tests", "integration.rs"),
      `#[test]\nfn it_works() {\n    assert_eq!(api_crate::api_val(), 2);\n}\n`,
    );

    const graph = await collectCrateGraph(wsDir);
    expect(graph.crates.core_crate?.layer).toBe(0);
    expect(graph.crates.api_crate?.layer).toBe(1);

    expect(resolveFileArchitecturalLayer(graph, "core_crate/src/lib.rs")).toEqual({
      crateName: "core_crate",
      layer: 0,
    });
    expect(resolveFileArchitecturalLayer(graph, "api_crate/src/lib.rs")).toEqual({
      crateName: "api_crate",
      layer: 1,
    });
    expect(resolveFileArchitecturalLayer(graph, "api_crate/tests/integration.rs")).toEqual({
      crateName: "api_crate",
      layer: graph.testLayer,
    });
    expect(graph.testLayer).toBeGreaterThan(1);
  });

  test("collectClippyDiagnostics extracts warnings on modified files and filters untouched files", async () => {
    const crateDir = await mkdtemp(join(tmpdir(), "peer-clippy-crate-"));
    tempDirs.push(crateDir);

    await mkdir(join(crateDir, "src"), { recursive: true });
    await writeFile(
      join(crateDir, "Cargo.toml"),
      `[package]\nname = "clippy_sample"\nversion = "0.1.0"\nedition = "2021"\n`,
    );

    // Modified file with a deliberate clippy::needless_return / unused variable warning
    await writeFile(
      join(crateDir, "src", "modified.rs"),
      `pub fn compute(x: i32) -> i32 {\n    return x + 1;\n}\n`,
    );

    // Unmodified file also containing a warning
    await writeFile(
      join(crateDir, "src", "untouched.rs"),
      `pub fn other(y: i32) -> i32 {\n    return y + 2;\n}\n`,
    );

    await writeFile(join(crateDir, "src", "lib.rs"), `pub mod modified;\npub mod untouched;\n`);

    const diagnostics = await collectClippyDiagnostics(crateDir, new Set(["src/modified.rs"]));

    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics.every((d) => d.filePath === "src/modified.rs")).toBe(true);
    const first = diagnostics[0];
    expect(first?.startLine).toBe(2);
    expect(first?.level).toBe("warning");
    expect(first?.message.length).toBeGreaterThan(0);
    // F-04: Column-scoped Clippy suggested_replacement must be spliced into the full line
    // ("    return x + 1;" -> "    x + 1"), not emitted as a bare expression fragment ("x + 1")
    expect(first?.suggestedReplacement).toBe("    x + 1");

    // F-13: Empty modifiedFiles set must return 0 warnings instead of bypassing the filter
    const emptyDiagnostics = await collectClippyDiagnostics(crateDir, new Set());
    expect(emptyDiagnostics.filter((d) => d.level === "warning").length).toBe(0);
  });

  test("findSuggestedReplacementForMessage ignores MaybeIncorrect and does not merge alternative child suggestions on the same line", () => {
    const lineText = "    let y = foo(x);";
    const msgWithTwoAlternatives = {
      level: "warning",
      message: "two alternative suggestions",
      spans: [],
      children: [
        {
          level: "help",
          message: "option A (MaybeIncorrect)",
          spans: [
            {
              file_name: "src/lib.rs",
              line_start: 10,
              line_end: 10,
              column_start: 13,
              column_end: 19,
              is_primary: true,
              suggested_replacement: "bar(x)",
              suggestion_applicability: "MaybeIncorrect",
              text: [{ text: lineText, highlight_start: 13, highlight_end: 19 }],
            },
          ],
        },
        {
          level: "help",
          message: "option B (MachineApplicable)",
          spans: [
            {
              file_name: "src/lib.rs",
              line_start: 10,
              line_end: 10,
              column_start: 13,
              column_end: 19,
              is_primary: true,
              suggested_replacement: "baz(x)",
              suggestion_applicability: "MachineApplicable",
              text: [{ text: lineText, highlight_start: 13, highlight_end: 19 }],
            },
          ],
        },
        {
          level: "help",
          message: "option C (second MachineApplicable alternative on same line)",
          spans: [
            {
              file_name: "src/lib.rs",
              line_start: 10,
              line_end: 10,
              column_start: 13,
              column_end: 19,
              is_primary: true,
              suggested_replacement: "qux(x)",
              suggestion_applicability: "MachineApplicable",
              text: [{ text: lineText, highlight_start: 13, highlight_end: 19 }],
            },
          ],
        },
      ],
    };

    expect(findSuggestedReplacementForMessage(msgWithTwoAlternatives)).toBe("    let y = baz(x);");
  });
});
