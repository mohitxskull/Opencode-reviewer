import { join } from "node:path";

import { z } from "zod";

import { ReviewProfileSchema } from "../domain/models.ts";
import { tryGitRawSync } from "./git.ts";

export class InvalidPeerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPeerConfigError";
  }
}

export const PeerToolsConfigSchema = z
  .object({
    clippy: z.boolean().default(true),
    audit: z.boolean().default(true),
    deny: z.boolean().default(false),
    geiger: z.boolean().default(false),
    semver: z.boolean().default(false),
    coverage: z.boolean().default(false),
    miri: z.boolean().default(false),
  })
  .strict();

export const PeerDiffConfigSchema = z
  .object({
    ignore: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const PeerPublishConfigSchema = z
  .object({
    mode: z.enum(["draft", "comment"]).default("draft"),
  })
  .strict();

export const PeerConfigRuleSchema = z
  .object({
    scope: z.string().min(1).nullable().optional(),
    rule: z.string().min(1),
  })
  .strict();

export const PeerDetectorModeSchema = z.enum(["error", "warn", "off"]);
export type PeerDetectorMode = z.infer<typeof PeerDetectorModeSchema>;

export const PeerDetectorsConfigSchema = z
  .object({
    unsafe: PeerDetectorModeSchema.default("error"),
    panic: PeerDetectorModeSchema.default("warn"),
  })
  .strict();

export const PeerTimeoutsConfigSchema = z
  .object({
    analyzer_secs: z.number().int().min(10).default(300),
    verifier_secs: z.number().int().min(10).default(120),
  })
  .strict();

export const PeerConfigSchema = z
  .object({
    profile: ReviewProfileSchema.default("assertive"),
    tools: PeerToolsConfigSchema.default({
      clippy: true,
      audit: true,
      deny: false,
      geiger: false,
      semver: false,
      coverage: false,
      miri: false,
    }),
    detectors: PeerDetectorsConfigSchema.default({
      unsafe: "error",
      panic: "warn",
    }),
    timeouts: PeerTimeoutsConfigSchema.default({
      analyzer_secs: 300,
      verifier_secs: 120,
    }),
    diff: PeerDiffConfigSchema.default({ ignore: [] }),
    publish: PeerPublishConfigSchema.default({ mode: "draft" }),
    rules: z.array(PeerConfigRuleSchema).default([]),
  })
  .strict();

export type PeerConfig = z.infer<typeof PeerConfigSchema>;

export const DEFAULT_PEER_CONFIG: PeerConfig = PeerConfigSchema.parse({});

export const DEFAULT_PEER_TOML_TEMPLATE = `# peer.toml — Repository configuration for peer (Rust PR reviewer)
# Loaded from the PR base branch (never from untrusted PR head commits).

# Review strictness: "quiet" | "chill" | "assertive"
profile = "assertive"

[tools]
# Core analyzers (enabled by default)
clippy = true
audit = true

# Optional Cargo analyzers (also toggleable via --tools)
deny = false       # auto-runs if deny.toml exists
geiger = false     # unsafe-code surface audit
semver = false     # breaking public API check against PR base
coverage = false   # changed-line coverage via cargo-llvm-cov
miri = false       # AST-gated UB check (runs only when diff touches unsafe)

[detectors]
# Built-in Tree-sitter AST detectors: "error" (Major) | "warn" (Minor) | "off"
unsafe = "error"
panic = "warn"

[timeouts]
analyzer_secs = 300  # timeout per Cargo analyzer (clippy, miri, llvm-cov, etc.)
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

export function parsePeerConfigToml(rawToml: string, sourceLabel = "peer.toml"): PeerConfig {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(rawToml);
  } catch (err) {
    throw new InvalidPeerConfigError(
      `Failed to parse ${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = PeerConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InvalidPeerConfigError(`Invalid ${sourceLabel}: ${details}`);
  }

  return result.data;
}

export function computePeerConfigHash(config: PeerConfig): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

// Why: A PR head commit is untrusted and could weaken `peer.toml` (e.g., disabling
// `audit`/`miri` or adding security-critical files to `diff.ignore`). Always read
// `peer.toml` from `gitRef` (pr.baseSha) via `git show` when reviewing a PR.
// However, when a repository is adopting `peer` for the first time (`baseSha` has no
// `peer.toml` yet) and `peer init` was just run locally, we allow the local `peer.toml`
// to additively enable optional tools and rules while enforcing the security floor
// (`clippy = true`, `audit = true`, `detectors.unsafe = "error"`, `diff.ignore = []`).
export async function loadPeerConfig(repoRoot: string, gitRef?: string): Promise<PeerConfig> {
  if (gitRef) {
    const fromGit = tryGitRawSync(repoRoot, ["show", `${gitRef}:peer.toml`]);
    if (fromGit.ok && fromGit.stdout.trim().length > 0) {
      return parsePeerConfigToml(fromGit.stdout, `${gitRef.slice(0, 7)}:peer.toml`);
    }
    const diskFile = Bun.file(join(repoRoot, "peer.toml"));
    if (!(await diskFile.exists())) {
      return DEFAULT_PEER_CONFIG;
    }
    const localCfg = parsePeerConfigToml(await diskFile.text(), join(repoRoot, "peer.toml"));
    return {
      ...DEFAULT_PEER_CONFIG,
      tools: {
        clippy: true,
        audit: true,
        deny: localCfg.tools.deny,
        geiger: localCfg.tools.geiger,
        semver: localCfg.tools.semver,
        coverage: localCfg.tools.coverage,
        miri: localCfg.tools.miri,
      },
      timeouts: localCfg.timeouts,
      rules: localCfg.rules,
    };
  }

  const diskFile = Bun.file(join(repoRoot, "peer.toml"));
  if (!(await diskFile.exists())) {
    return DEFAULT_PEER_CONFIG;
  }
  return parsePeerConfigToml(await diskFile.text(), join(repoRoot, "peer.toml"));
}
