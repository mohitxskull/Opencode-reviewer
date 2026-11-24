import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { hasCargoDenyConfig } from "../analyzers/deny.ts";
import type { OptionalTool } from "../pipeline/analyze.ts";
import { runCheckGate } from "../pipeline/check.ts";
import { tryGitRawSync } from "../workspace/git.ts";

export interface InitCommandOptions {
  readonly fresh?: boolean;
  readonly install?: boolean;
  readonly baseline?: boolean;
  readonly ci?: boolean;
  readonly tools?: ReadonlySet<OptionalTool>;
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly commandRunner?: (
    cmd: readonly string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface WorkspaceInspection {
  readonly isCargoWorkspace: boolean;
  readonly packageCount: number;
  readonly hasPublishableLib: boolean;
  readonly hasUnsafeCode: boolean;
  readonly allowedLicenses: readonly string[];
}

const SAFE_OSI_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Zlib",
  "0BSD",
  "CC0-1.0",
  "MPL-2.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "BSL-1.0",
  "Unlicense",
  "OpenSSL",
]);

const DEFAULT_BASE_LICENSES = [
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Zlib",
  "0BSD",
  "CC0-1.0",
  "MPL-2.0",
  "BSL-1.0",
  "Unlicense",
];

interface CargoMetadataPackage {
  readonly id?: string;
  readonly name?: string;
  readonly license?: string | null;
  readonly publish?: readonly string[] | null;
  readonly targets?: ReadonlyArray<{ readonly kind?: readonly string[] }>;
}

interface CargoMetadataOutput {
  readonly packages?: readonly CargoMetadataPackage[];
  readonly workspace_members?: readonly string[];
}

export async function inspectRustWorkspace(repoRoot: string): Promise<WorkspaceInspection> {
  const cargoToml = Bun.file(join(repoRoot, "Cargo.toml"));
  if (!(await cargoToml.exists())) {
    return {
      isCargoWorkspace: false,
      packageCount: 0,
      hasPublishableLib: false,
      hasUnsafeCode: false,
      allowedLicenses: DEFAULT_BASE_LICENSES,
    };
  }

  const allowedSet = new Set<string>(DEFAULT_BASE_LICENSES);
  let packageCount = 1;
  let hasPublishableLib = false;

  const metaProc = Bun.spawnSync(["cargo", "metadata", "--format-version", "1"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (metaProc.exitCode === 0) {
    try {
      const meta = JSON.parse(metaProc.stdout.toString()) as CargoMetadataOutput;
      const memberIds = new Set(meta.workspace_members ?? []);
      const packages = meta.packages ?? [];
      const memberPackages = packages.filter((p) => p.id && memberIds.has(p.id));
      packageCount = Math.max(1, memberPackages.length);

      for (const pkg of memberPackages) {
        const isPublishable =
          pkg.publish === null || (Array.isArray(pkg.publish) && pkg.publish.length > 0);
        const hasLibTarget = (pkg.targets ?? []).some((t) =>
          (t.kind ?? []).some((k) => k === "lib" || k === "rlib" || k === "proc-macro"),
        );
        const hasBinTarget = (pkg.targets ?? []).some((t) =>
          (t.kind ?? []).some((k) => k === "bin"),
        );
        // Only default `semver = true` for pure library crates (or workspaces with a dedicated library crate)
        if (isPublishable && hasLibTarget && !hasBinTarget) {
          hasPublishableLib = true;
        }
      }

      for (const pkg of packages) {
        if (!pkg.license) continue;
        const tokens = pkg.license
          .split(/\s+(?:OR|AND)\s+|\(|\)|\//g)
          .map((t) => t.trim())
          .filter(Boolean);
        for (const token of tokens) {
          if (SAFE_OSI_LICENSES.has(token)) {
            allowedSet.add(token);
          }
        }
      }
    } catch {
      // Fallback to defaults if cargo metadata JSON cannot be parsed
    }
  }

  const grepUnsafe = tryGitRawSync(repoRoot, ["grep", "-q", "\\bunsafe\\b", "--", "*.rs"]);
  const hasUnsafeCode = grepUnsafe.ok;

  return {
    isCargoWorkspace: true,
    packageCount,
    hasPublishableLib,
    hasUnsafeCode,
    allowedLicenses: Array.from(allowedSet).sort(),
  };
}

export function buildTailoredPeerToml(options: {
  readonly deny: boolean;
  readonly geiger: boolean;
  readonly semver: boolean;
  readonly coverage: boolean;
  readonly miri: boolean;
  readonly analyzerSecs: number;
}): string {
  return `# peer.toml — Repository configuration for peer (Agent-First Rust PR Reviewer)
# Loaded from the PR base branch (never weakened by untrusted PR head commits).

# Review strictness: "quiet" | "chill" | "assertive"
profile = "assertive"

[tools]
# Core analyzers (enabled by default)
clippy = true
audit = true

# Optional Cargo analyzers (also toggleable via --tools)
deny = ${options.deny}       # supply-chain, license & duplicate-crate policy via deny.toml
geiger = ${options.geiger}     # unsafe-code surface audit
semver = ${options.semver}     # breaking public API check (recommended for published library crates)
coverage = ${options.coverage}   # changed-line test coverage via cargo-llvm-cov
miri = ${options.miri}       # AST-gated UB check (runs only when diff touches unsafe)

[detectors]
# Built-in Tree-sitter AST detectors: "error" (Major) | "warn" (Minor) | "off"
unsafe = "error"
panic = "warn"

[timeouts]
analyzer_secs = ${options.analyzerSecs}  # timeout per Cargo analyzer
verifier_secs = 120  # timeout per suggestion cargo check

[diff]
# Extra glob patterns to exclude from review (in addition to docs/, .github/, *.md, *.lock)
ignore = []

[publish]
# Default mode for \`peer publish\`: "draft" (PENDING) | "comment" (submitted)
mode = "draft"

# Optional version-controlled repository rules (merged with .peer/learnings.json)
# [[rules]]
# scope = "src/**"
# rule = "Never hold std::sync::Mutex across .await; use parking_lot::Mutex."
`;
}

export function buildTailoredDenyToml(allowedLicenses: readonly string[]): string {
  const licenseList = allowedLicenses.map((l) => `  "${l}",`).join("\n");
  return `# deny.toml — Generated by \`peer init\` for cargo-deny 0.22+
# Docs: https://embarkstudios.github.io/cargo-deny/

[advisories]
unmaintained = "workspace"
yanked = "warn"

[licenses]
confidence-threshold = 0.8
allow = [
${licenseList}
]

[bans]
multiple-versions = "warn"
wildcards = "allow"

[sources]
unknown-registry = "warn"
unknown-git = "warn"
`;
}

const PEER_CI_WORKFLOW_YAML = `name: Peer Rust Gate

on:
  pull_request:
  push:
    branches: [main, master]

permissions:
  contents: read

jobs:
  peer-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      - uses: mohitxskull/Opencode-reviewer@main
        with:
          base: \${{ github.event.pull_request.base.sha || 'main' }}
          sarif-file: peer.sarif
`;

const INSTALLABLE_CARGO_BINS: ReadonlyArray<{
  readonly key: "audit" | "deny" | "geiger" | "semver" | "coverage";
  readonly binary: string;
  readonly crateName: string;
}> = [
  { key: "audit", binary: "cargo-audit", crateName: "cargo-audit" },
  { key: "deny", binary: "cargo-deny", crateName: "cargo-deny" },
  { key: "geiger", binary: "cargo-geiger", crateName: "cargo-geiger" },
  { key: "semver", binary: "cargo-semver-checks", crateName: "cargo-semver-checks" },
  { key: "coverage", binary: "cargo-llvm-cov", crateName: "cargo-llvm-cov" },
];

async function defaultCommandRunner(
  cmd: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function runInitCommand(
  repoRoot: string,
  options: InitCommandOptions,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): Promise<number> {
  const fresh = options.fresh ?? false;
  const install = options.install ?? false;
  const baseline = options.baseline ?? false;
  const ci = options.ci ?? false;
  const requestedTools = options.tools ?? new Set<OptionalTool>();
  const isJson = options.json ?? false;
  const isQuiet = options.quiet ?? false;
  const runner = options.commandRunner ?? defaultCommandRunner;

  const targetPeerToml = join(repoRoot, "peer.toml");
  const peerTomlFile = Bun.file(targetPeerToml);

  if ((await peerTomlFile.exists()) && !fresh) {
    const msg = `${targetPeerToml} already exists. Pass --fresh to overwrite.`;
    writeErr(`Error: ${msg}`);
    if (isJson || isQuiet) {
      writeOut(
        JSON.stringify(
          {
            status: "error",
            exitCode: 2,
            errorCode: "ALREADY_INITIALIZED",
            message: msg,
            remediationCommand: "peer init --fresh",
          },
          null,
          isQuiet ? undefined : 2,
        ),
      );
    }
    return 2;
  }

  const workspace = await inspectRustWorkspace(repoRoot);
  const filesCreated: string[] = [];
  const filesSkipped: string[] = [];

  // 1. Scaffold deny.toml when in a Cargo workspace (if missing or --fresh)
  let denyConfigured = await hasCargoDenyConfig(repoRoot);
  if (workspace.isCargoWorkspace || requestedTools.has("deny")) {
    const targetDenyToml = join(repoRoot, "deny.toml");
    const denyExists = await hasCargoDenyConfig(repoRoot);
    if (!denyExists || fresh) {
      await Bun.write(targetDenyToml, buildTailoredDenyToml(workspace.allowedLicenses));
      filesCreated.push(resolve(targetDenyToml));
      denyConfigured = true;
    } else {
      filesSkipped.push(resolve(targetDenyToml));
    }
  }

  // 2. Write tailored peer.toml
  const enableDeny = denyConfigured || requestedTools.has("deny");
  const enableGeiger = workspace.hasUnsafeCode || requestedTools.has("geiger");
  const enableSemver = workspace.hasPublishableLib || requestedTools.has("semver");
  const enableCoverage = requestedTools.has("coverage");
  const enableMiri = requestedTools.has("miri");

  const peerTomlContent = buildTailoredPeerToml({
    deny: enableDeny,
    geiger: enableGeiger,
    semver: enableSemver,
    coverage: enableCoverage,
    miri: enableMiri,
    analyzerSecs: workspace.packageCount > 3 ? 600 : 300,
  });
  await Bun.write(targetPeerToml, peerTomlContent);
  filesCreated.push(resolve(targetPeerToml));

  // 3. Optional GitHub Actions CI workflow (--ci)
  if (ci) {
    const workflowDir = join(repoRoot, ".github", "workflows");
    const workflowPath = join(workflowDir, "peer.yml");
    const wfExists = await Bun.file(workflowPath).exists();
    if (!wfExists || fresh) {
      await mkdir(workflowDir, { recursive: true });
      await Bun.write(workflowPath, PEER_CI_WORKFLOW_YAML);
      filesCreated.push(resolve(workflowPath));
    } else {
      filesSkipped.push(resolve(workflowPath));
    }
  }

  // 4. Check & optionally install Cargo analyzers (--install)
  const desiredInstallKeys = new Set<"audit" | "deny" | "geiger" | "semver" | "coverage">([
    "audit",
    ...(enableDeny ? (["deny"] as const) : []),
    ...(enableGeiger ? (["geiger"] as const) : []),
    ...(enableSemver ? (["semver"] as const) : []),
    ...(enableCoverage ? (["coverage"] as const) : []),
  ]);

  const installedTools: string[] = [];
  const missingTools: Array<{ name: string; installCommand: string }> = [];
  const hasBinstall = Boolean(Bun.which("cargo-binstall"));

  for (const spec of INSTALLABLE_CARGO_BINS) {
    const alreadyPresent = Boolean(Bun.which(spec.binary));
    if (alreadyPresent) {
      installedTools.push(spec.binary);
      continue;
    }

    if (install && desiredInstallKeys.has(spec.key)) {
      const installCmd = hasBinstall
        ? ["cargo", "binstall", "-y", spec.crateName]
        : ["cargo", "install", "--locked", spec.crateName];
      const res = await runner(installCmd, repoRoot);
      if (res.exitCode === 0) {
        installedTools.push(spec.binary);
        continue;
      }
    }

    if (desiredInstallKeys.has(spec.key)) {
      missingTools.push({
        name: spec.binary,
        installCommand: hasBinstall
          ? `cargo binstall -y ${spec.crateName}`
          : `cargo install --locked ${spec.crateName}`,
      });
    }
  }

  // 5. Optional brownfield baseline generation (--baseline)
  let baselineUpdated = false;
  if (baseline && workspace.isCargoWorkspace) {
    const code = await runCheckGate({
      repoRoot,
      cliTools: new Set(),
      updateBaseline: true,
      allFiles: true,
      json: true,
      quiet: true,
      writeOut: () => {},
      writeErr,
    });
    if (code === 0) {
      baselineUpdated = true;
      filesCreated.push(resolve(repoRoot, ".peer", "baseline.json"));
    }
  }

  const enabledTools = [
    "clippy",
    "audit",
    ...(enableDeny ? ["deny"] : []),
    ...(enableGeiger ? ["geiger"] : []),
    ...(enableSemver ? ["semver"] : []),
    ...(enableCoverage ? ["coverage"] : []),
    ...(enableMiri ? ["miri"] : []),
  ];

  const payload = {
    status: "initialized",
    workspace: {
      isCargoWorkspace: workspace.isCargoWorkspace,
      packageCount: workspace.packageCount,
      hasPublishableLib: workspace.hasPublishableLib,
      hasUnsafeCode: workspace.hasUnsafeCode,
      allowedLicensesCount: workspace.allowedLicenses.length,
    },
    enabledTools,
    filesCreated,
    filesSkipped,
    installedTools,
    missingTools,
    baselineUpdated,
  };

  if (isJson || isQuiet) {
    writeOut(JSON.stringify(payload, null, isQuiet ? undefined : 2));
    return 0;
  }

  const lines = [
    `Initialized peer in ${repoRoot}`,
    ...filesCreated.map((f) => `  Created ${f}`),
    ...filesSkipped.map((f) => `  Kept existing ${f} (pass --fresh to overwrite)`),
    `  Enabled tools in peer.toml: ${enabledTools.join(", ")}`,
  ];
  if (missingTools.length > 0) {
    lines.push(
      `  Missing optional binaries (run 'peer init --fresh --install' to auto-install):`,
      ...missingTools.map((m) => `    - ${m.name}: ${m.installCommand}`),
    );
  }
  writeOut(lines.join("\n"));
  return 0;
}
