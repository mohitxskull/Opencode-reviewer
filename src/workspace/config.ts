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
    analyzer_secs: z.number().int().min(10).max(3600).default(300),
    verifier_secs: z.number().int().min(10).max(3600).default(120),
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
// `audit`/`miri`, adding security-critical files to `diff.ignore`, or injecting prompt
// `[[rules]]`). When `gitRef` (pr.baseSha) is provided, always read `peer.toml` from
// `gitRef` via `git show` — never from the checked-out PR working tree.
export async function loadPeerConfig(repoRoot: string, gitRef?: string): Promise<PeerConfig> {
  if (gitRef) {
    const fromGit = tryGitRawSync(repoRoot, ["show", `${gitRef}:peer.toml`]);
    if (!fromGit.ok || fromGit.stdout.trim().length === 0) {
      return DEFAULT_PEER_CONFIG;
    }
    return parsePeerConfigToml(fromGit.stdout, `${gitRef.slice(0, 7)}:peer.toml`);
  }

  const diskFile = Bun.file(join(repoRoot, "peer.toml"));
  if (!(await diskFile.exists())) {
    return DEFAULT_PEER_CONFIG;
  }
  return parsePeerConfigToml(await diskFile.text(), join(repoRoot, "peer.toml"));
}
