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
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO",
  "CC",
  "CXX",
  "AR",
  "PKG_CONFIG_PATH",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const ALLOWED_CARGO_ENV_PREFIXES = ["CARGO_HTTP_", "CARGO_NET_", "SCCACHE_"] as const;

// Why: Running `cargo metadata`, `cargo clippy`, or `cargo check` on an untrusted
// PR commit executes its `build.rs` and proc-macros. Inheriting full `process.env`
// would leak `PEER_GITHUB_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, and cloud keys.
// Passing an explicit allowlisted environment prevents credential exfiltration
// while preserving corporate proxies, TLS certs, and sccache/Cargo network settings.
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
  for (const [key, val] of Object.entries(sourceEnv)) {
    if (
      typeof val === "string" &&
      val.length > 0 &&
      ALLOWED_CARGO_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}
