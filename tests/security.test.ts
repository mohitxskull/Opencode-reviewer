import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CargoAuditMissingError,
  collectSecurityAdvisories,
  diffCargoLockToml,
  formatCargoLockDiffPromptSection,
  formatSecurityAdvisoriesPromptSection,
  parseCargoAuditJson,
} from "../src/analyzers/security.ts";
import { buildScrubbedCargoEnv } from "../src/infra/env.ts";
import { advisoriesToFindings } from "../src/judge/partition.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Deterministic CVE & RustSec advisory collector", () => {
  test("parseCargoAuditJson extracts vulnerabilities, CVE aliases, affected functions, and unsound warnings", () => {
    const sampleCargoAuditOutput = JSON.stringify({
      vulnerabilities: {
        found: true,
        count: 1,
        list: [
          {
            advisory: {
              id: "RUSTSEC-2024-0370",
              package: "h2",
              title: "CONTINUATION frame flood DoS",
              description: "An attacker can send unbounded CONTINUATION frames.",
              url: "https://rustsec.org/advisories/RUSTSEC-2024-0370",
              aliases: ["CVE-2024-28180", "GHSA-xxxx-yyyy"],
              cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
            },
            versions: {
              patched: [">=0.3.26", ">=0.4.4"],
              unaffected: [],
            },
            affected: {
              functions: {
                "h2::codec::framed_read::FramedRead::poll_next": ["<0.3.26"],
              },
            },
            package: {
              name: "h2",
              version: "0.3.24",
            },
          },
        ],
      },
      warnings: {
        unsound: [
          {
            kind: "unsound",
            package: { name: "ouroboros", version: "0.15.6" },
            advisory: {
              id: "RUSTSEC-2023-0042",
              package: "ouroboros",
              title: "Unsound self-referential struct",
              description: "Aliasing violation under Stacked Borrows.",
              url: "https://rustsec.org/advisories/RUSTSEC-2023-0042",
              aliases: [],
              cvss: null,
            },
            versions: {
              patched: [">=0.17.0"],
            },
          },
        ],
      },
    });

    const advisories = parseCargoAuditJson(sampleCargoAuditOutput);
    expect(advisories.length).toBe(2);

    const vuln = advisories[0];
    expect(vuln?.id).toBe("RUSTSEC-2024-0370");
    expect(vuln?.aliases).toEqual(["CVE-2024-28180", "GHSA-xxxx-yyyy"]);
    expect(vuln?.kind).toBe("vulnerability");
    expect(vuln?.packageName).toBe("h2");
    expect(vuln?.packageVersion).toBe("0.3.24");
    expect(vuln?.patchedVersions).toEqual([">=0.3.26", ">=0.4.4"]);
    expect(vuln?.affectedFunctions).toEqual(["h2::codec::framed_read::FramedRead::poll_next"]);

    const unsound = advisories[1];
    expect(unsound?.id).toBe("RUSTSEC-2023-0042");
    expect(unsound?.kind).toBe("unsound");

    const promptSection = formatSecurityAdvisoriesPromptSection(advisories);
    expect(promptSection).toContain("RUSTSEC-2024-0370");
    expect(promptSection).toContain("CVE-2024-28180");
    expect(promptSection).toContain("h2::codec::framed_read::FramedRead::poll_next");
    expect(promptSection).toContain("Confirm reachability");
  });

  test("collectSecurityAdvisories throws CargoAuditMissingError with install instructions when cargo-audit is not installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-sec-missing-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "Cargo.lock"), "version = 3\n");

    await expect(
      collectSecurityAdvisories(dir, {
        runner: async () => ({
          stdout: "",
          stderr: "error: no such command: `audit`",
          exitCode: 101,
        }),
      }),
    ).rejects.toThrow(CargoAuditMissingError);
  });

  test("advisoriesToFindings maps direct Cargo.toml dependency line and emits Security findings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-sec-cargo-"));
    tempDirs.push(dir);

    await writeFile(
      join(dir, "Cargo.toml"),
      [
        "[package]",
        'name = "demo"',
        'version = "0.1.0"',
        "",
        "[dependencies]",
        'tokio = "1.37"',
        'openssl = "0.10.55"',
        "",
      ].join("\n"),
    );

    const findings = await advisoriesToFindings(
      [
        {
          id: "RUSTSEC-2023-0072",
          aliases: ["CVE-2023-5678"],
          packageName: "openssl",
          packageVersion: "0.10.55",
          kind: "vulnerability",
          title: "Use-after-free in openssl",
          description: "Memory safety bug.",
          url: "https://rustsec.org/advisories/RUSTSEC-2023-0072",
          cvss: null,
          patchedVersions: [">=0.10.60"],
          affectedFunctions: [],
          source: "cargo-audit",
        },
      ],
      dir,
    );

    expect(findings.length).toBe(1);
    expect(findings[0]?.filePath).toBe("Cargo.toml");
    expect(findings[0]?.startLine).toBe(7);
    expect(findings[0]?.severity).toBe("Critical");
    expect(findings[0]?.type).toBe("Security");
    expect(findings[0]?.source).toBe("audit");
    expect(findings[0]?.title).toContain("CVE-2023-5678");
  });

  test("buildScrubbedCargoEnv strips secrets and SSH sockets while keeping Cargo/Rust toolchain vars", () => {
    const scrubbed = buildScrubbedCargoEnv({
      PATH: "/usr/bin:/home/user/.cargo/bin",
      HOME: "/home/user",
      CARGO_HOME: "/home/user/.cargo",
      PEER_GITHUB_TOKEN: "ghp_super_secret",
      GITHUB_TOKEN: "gho_secret",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      OPENAI_API_KEY: "sk-secret",
    });

    expect(scrubbed.PATH).toBe("/usr/bin:/home/user/.cargo/bin");
    expect(scrubbed.CARGO_HOME).toBe("/home/user/.cargo");
    expect(scrubbed.PEER_GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.SSH_AUTH_SOCK).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
  });

  test("diffCargoLockToml parses Cargo.lock via Bun.TOML.parse and detects added, changed, and removed crates", () => {
    const baseLock = `
version = 3

[[package]]
name = "serde"
version = "1.0.200"

[[package]]
name = "old_dep"
version = "0.1.0"
`;
    const headLock = `
version = 3

[[package]]
name = "serde"
version = "1.0.210"

[[package]]
name = "new_dep"
version = "0.2.3"
`;
    const diff = diffCargoLockToml(baseLock, headLock);
    expect(diff.added).toEqual([{ name: "new_dep", version: "0.2.3" }]);
    expect(diff.removed).toEqual([{ name: "old_dep", version: "0.1.0" }]);
    expect(diff.changed).toEqual([{ name: "serde", from: ["1.0.200"], to: ["1.0.210"] }]);

    const section = formatCargoLockDiffPromptSection(diff);
    expect(section).toContain("[ADDED] `new_dep` `0.2.3`");
    expect(section).toContain("[CHANGED] `serde` `1.0.200` -> `1.0.210`");
    expect(section).toContain("[REMOVED] `old_dep` `0.1.0`");
  });
});
