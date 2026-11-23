interface ToolCheckSpec {
  readonly name: string;
  readonly bin: string;
  readonly required: boolean;
  readonly installHint: string;
  readonly versionArgs: readonly string[];
}

const TOOL_SPECS: readonly ToolCheckSpec[] = [
  {
    name: "git",
    bin: "git",
    required: true,
    installHint: "Install git via your OS package manager",
    versionArgs: ["--version"],
  },
  {
    name: "rustc",
    bin: "rustc",
    required: true,
    installHint: "https://rustup.rs",
    versionArgs: ["--version"],
  },
  {
    name: "cargo",
    bin: "cargo",
    required: true,
    installHint: "https://rustup.rs",
    versionArgs: ["--version"],
  },
  {
    name: "gh",
    bin: "gh",
    required: false,
    installHint: "https://cli.github.com (or set PEER_GITHUB_TOKEN)",
    versionArgs: ["--version"],
  },
  {
    name: "cargo-audit",
    bin: "cargo-audit",
    required: false,
    installHint: "cargo install cargo-audit",
    versionArgs: ["--version"],
  },
  {
    name: "cargo-deny",
    bin: "cargo-deny",
    required: false,
    installHint: "cargo install cargo-deny",
    versionArgs: ["--version"],
  },
  {
    name: "cargo-geiger",
    bin: "cargo-geiger",
    required: false,
    installHint: "cargo install cargo-geiger",
    versionArgs: ["--version"],
  },
  {
    name: "cargo-semver-checks",
    bin: "cargo-semver-checks",
    required: false,
    installHint: "cargo install cargo-semver-checks",
    versionArgs: ["--version"],
  },
  {
    name: "cargo-llvm-cov",
    bin: "cargo-llvm-cov",
    required: false,
    installHint: "cargo install cargo-llvm-cov",
    versionArgs: ["--version"],
  },
];

function probeVersion(binPath: string, args: readonly string[]): string {
  const proc = Bun.spawnSync([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    return "installed";
  }
  return proc.stdout.toString().trim().split("\n")[0]?.slice(0, 48) || "installed";
}

function probeMiri(): { status: string; detail: string } {
  const cargoPath = Bun.which("cargo");
  if (!cargoPath) {
    return { status: "missing", detail: "rustup +nightly component add miri" };
  }
  const proc = Bun.spawnSync([cargoPath, "+nightly", "miri", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) {
    return {
      status: "ok",
      detail: proc.stdout.toString().trim().split("\n")[0]?.slice(0, 48) || "installed",
    };
  }
  return { status: "missing", detail: "rustup +nightly component add miri" };
}

export async function runDoctorCommand(writeOut: (text: string) => void): Promise<number> {
  const rows: Array<{ Tool: string; Kind: string; Status: string; Details: string }> = [];
  let missingRequired = 0;

  for (const spec of TOOL_SPECS) {
    const resolved = Bun.which(spec.bin);
    if (resolved) {
      rows.push({
        Tool: spec.name,
        Kind: spec.required ? "required" : "optional",
        Status: "ok",
        Details: probeVersion(resolved, spec.versionArgs),
      });
    } else {
      if (spec.required) {
        missingRequired += 1;
      }
      rows.push({
        Tool: spec.name,
        Kind: spec.required ? "required" : "optional",
        Status: "missing",
        Details: spec.installHint,
      });
    }
  }

  const miri = probeMiri();
  rows.push({
    Tool: "miri (+nightly)",
    Kind: "optional",
    Status: miri.status,
    Details: miri.detail,
  });

  writeOut("peer doctor — Local Toolchain & Rust Analyzer Readiness\n");
  writeOut(Bun.inspect.table(rows, ["Tool", "Kind", "Status", "Details"]));
  return missingRequired > 0 ? 1 : 0;
}
