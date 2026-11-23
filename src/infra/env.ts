const ALLOWED_CARGO_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_TARGET_DIR",
  "RUSTFLAGS",
  "RUSTC",
  "CARGO",
  "CC",
  "CXX",
  "AR",
  "PKG_CONFIG_PATH",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "XDG_CACHE_HOME",
] as const;

// Why: Running `cargo metadata`, `cargo clippy`, or `cargo check` on an untrusted
// PR commit executes its `build.rs` and proc-macros. Inheriting full `process.env`
// would leak `PEER_GITHUB_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, and cloud keys.
// Passing an explicit allowlisted environment prevents credential exfiltration.
export function buildScrubbedCargoEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const key of ALLOWED_CARGO_ENV_KEYS) {
    const val = sourceEnv[key];
    if (typeof val === "string" && val.length > 0) {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}
