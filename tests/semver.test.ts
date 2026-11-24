import { describe, expect, test } from "bun:test";

import {
  CargoSemverChecksMissingError,
  collectCargoSemverViolations,
  formatSemverPromptSection,
  parseCargoSemverOutput,
  semverViolationsToFindings,
} from "../src/analyzers/semver.ts";

const SAMPLE_SEMVER_OUTPUT = `
--- failure function_missing: pub fn removed or renamed ---
Description:
A publicly-visible function cannot be imported by its prior path. A \`pub use\` may have been removed, or the function itself may have been renamed or removed entirely.
Ref: https://doc.rust-lang.org/cargo/reference/semver.html#item-remove
Impl: https://github.com/obi1kenobi/cargo-semver-checks/tree/v0.35.0/src/lints/function_missing.ron

Failed in:
  function my_crate::api::connect, previously in file src/api.rs:42
  function my_crate::api::disconnect, previously in file src/api.rs:88

--- failure struct_pub_field_missing: pub struct's pub field removed or renamed ---
Description:
A publicly-visible struct has at least one public field that is no longer available under its prior name.

Failed in:
  field Config.timeout in file src/config.rs:15
  type OrderIntentStore is no longer UnwindSafe, in /workspace/repo/target/semver-checks/git-7748580a6e47a3ebf1a4bf48862c6a3dfc4467d5/6b3e6945468ab41450a7574fe358eda71a5329a5/src/exchange/orders.rs:315
`;

describe("cargo-semver-checks integration", () => {
  test("parses failure blocks and file:line locations into SemVer findings", () => {
    const violations = parseCargoSemverOutput(SAMPLE_SEMVER_OUTPUT, "/workspace/repo");
    expect(violations.length).toBe(4);
    expect(violations[0]?.lint).toBe("function_missing");
    expect(violations[0]?.filePath).toBe("src/api.rs");
    expect(violations[0]?.line).toBe(42);
    expect(violations[0]?.symbol).toContain("my_crate::api::connect");

    expect(violations[2]?.lint).toBe("struct_pub_field_missing");
    expect(violations[2]?.filePath).toBe("src/config.rs");
    expect(violations[2]?.line).toBe(15);

    expect(violations[3]?.filePath).toBe("src/exchange/orders.rs");
    expect(violations[3]?.line).toBe(315);
    expect(violations[3]?.symbol).toContain("OrderIntentStore");

    const prompt = formatSemverPromptSection(violations);
    expect(prompt).toContain("function_missing");
    expect(prompt).toContain("src/api.rs:42");

    const findings = semverViolationsToFindings(violations);
    expect(findings.length).toBe(3);
    expect(findings[0]?.severity).toBe("Major");
    expect(findings[0]?.body).toContain("my_crate::api::connect (L42)");
    expect(findings[0]?.body).toContain("my_crate::api::disconnect (L88)");
    expect(findings[0]?.source).toBe("audit");
  });

  test("skips when disabled and throws CargoSemverChecksMissingError when tool is missing", async () => {
    const skipped = await collectCargoSemverViolations("/tmp/nonexistent", {
      enabled: false,
      baseSha: "abc1234",
    });
    expect(skipped).toEqual([]);

    await expect(
      collectCargoSemverViolations("/tmp/nonexistent", {
        enabled: true,
        baseSha: "abc1234",
        runner: async () => ({
          stdout: "",
          stderr: "error: no such command: `semver-checks`",
          exitCode: 101,
        }),
      }),
    ).rejects.toThrow(CargoSemverChecksMissingError);
  });
});
