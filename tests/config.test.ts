import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { filterCodeOnlyDiffMap } from "../src/domain/diff.ts";
import {
  InvalidPeerConfigError,
  loadPeerConfig,
  parsePeerConfigToml,
} from "../src/workspace/config.ts";
import { LearningStore } from "../src/workspace/learnings.ts";

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
  return res.stdout.toString().trim();
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("peer.toml repository configuration", () => {
  test("parses valid peer.toml and rejects unknown keys strictly", () => {
    const cfg = parsePeerConfigToml(`
profile = "chill"

[tools]
clippy = true
audit = false
geiger = true
miri = true

[diff]
ignore = ["**/generated/**", "**/*.pb.rs"]

[publish]
mode = "comment"

[[rules]]
scope = "src/oms/**"
rule = "Never hold std::sync::Mutex across .await"
`);

    expect(cfg.profile).toBe("chill");
    expect(cfg.tools.clippy).toBe(true);
    expect(cfg.tools.audit).toBe(false);
    expect(cfg.tools.geiger).toBe(true);
    expect(cfg.tools.miri).toBe(true);
    expect(cfg.tools.semver).toBe(false);
    expect(cfg.diff.ignore).toEqual(["**/generated/**", "**/*.pb.rs"]);
    expect(cfg.publish.mode).toBe("comment");
    expect(cfg.rules.length).toBe(1);

    expect(() => parsePeerConfigToml(`profil = "chill"\n`)).toThrow(InvalidPeerConfigError);
    expect(() => parsePeerConfigToml(`[tools]\nunknown_tool = true\n`)).toThrow(
      InvalidPeerConfigError,
    );
  });

  test("loadPeerConfig reads peer.toml strictly from baseSha (ignoring untrusted PR head edits)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-cfg-git-"));
    tempDirs.push(dir);

    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Tester"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);

    await writeFile(join(dir, "peer.toml"), `profile = "chill"\n\n[tools]\naudit = true\n`);
    runGit(dir, ["add", "peer.toml"]);
    runGit(dir, ["commit", "-m", "base peer.toml"]);
    const baseSha = runGit(dir, ["rev-parse", "HEAD"]);

    // Untrusted PR head tries to weaken peer.toml
    await writeFile(join(dir, "peer.toml"), `profile = "quiet"\n\n[tools]\naudit = false\n`);
    runGit(dir, ["add", "peer.toml"]);
    runGit(dir, ["commit", "-m", "pr weakens peer.toml"]);

    const loaded = await loadPeerConfig(dir, baseSha);
    expect(loaded.profile).toBe("chill");
    expect(loaded.tools.audit).toBe(true);
  });

  test("filterCodeOnlyDiffMap applies [diff].ignore globs while always keeping peer.toml reviewable", () => {
    const emptyHunk = {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newEnd: 1,
      header: "@@ -1,1 +1,1 @@",
      annotatedLines: ["L0001 (+): // x"],
      rightSideLines: [1],
    };
    const filtered = filterCodeOnlyDiffMap(
      {
        "src/lib.rs": { filePath: "src/lib.rs", hunks: [emptyHunk] },
        "src/generated/proto.pb.rs": { filePath: "src/generated/proto.pb.rs", hunks: [emptyHunk] },
        "peer.toml": { filePath: "peer.toml", hunks: [emptyHunk] },
      },
      ["**/*.pb.rs", "peer.toml"],
    );

    expect(Object.keys(filtered).sort()).toEqual(["peer.toml", "src/lib.rs"]);
  });

  test("LearningStore merges [[rules]] from peer.toml with path scope matching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-cfg-rules-"));
    tempDirs.push(dir);
    runGit(dir, ["init", "-b", "main"]);

    const store = new LearningStore(dir);
    const matched = await store.getMatchingLearnings(["src/oms/engine.rs"], undefined, [
      { scope: "src/oms/**", rule: "Use parking_lot::Mutex" },
      { scope: "src/cli/**", rule: "CLI-only rule" },
    ]);

    expect(matched.length).toBe(1);
    expect(matched[0]?.rule).toBe("Use parking_lot::Mutex");
  });

  test("peer init scaffolds valid peer.toml and refuses overwrite without --fresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-init-"));
    tempDirs.push(dir);
    runGit(dir, ["init", "-b", "main"]);

    const out: string[] = [];
    const err: string[] = [];

    const code1 = await runCli(["init", "--repo", dir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(code1).toBe(0);
    expect(await Bun.file(join(dir, "peer.toml")).exists()).toBe(true);

    // Scaffolded file must parse cleanly under strict schema
    const parsed = await loadPeerConfig(dir);
    expect(parsed.profile).toBe("assertive");

    // Second run without --fresh fails
    const code2 = await runCli(["init", "--repo", dir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(code2).toBe(2);
    expect(err.join("\n")).toContain("already exists");

    // Second run with --fresh succeeds
    const code3 = await runCli(["init", "--fresh", "--repo", dir], {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(code3).toBe(0);
  });

  test("peer init in a Cargo workspace generates repo-tailored peer.toml, working deny.toml, and optional CI workflow in JSON mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer-init-cargo-"));
    tempDirs.push(dir);
    runGit(dir, ["init", "-b", "main"]);
    runGit(dir, ["config", "user.name", "Tester"]);
    runGit(dir, ["config", "user.email", "test@example.com"]);

    await writeFile(
      join(dir, "Cargo.toml"),
      `[package]\nname = "demo_app"\nversion = "0.1.0"\nedition = "2021"\nlicense = "MIT OR Apache-2.0"\n`,
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.rs"), `fn main() {\n    unsafe { let _x = 1; }\n}\n`);
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-m", "initial cargo app with unsafe"]);
    const baseSha = runGit(dir, ["rev-parse", "HEAD"]);

    const out: string[] = [];
    const code = await runCli(["init", "--ci", "--json", "--repo", dir], {
      stdout: (t) => out.push(t),
    });
    expect(code).toBe(0);
    const payload = JSON.parse(out.join("\n")) as {
      status: string;
      workspace: { isCargoWorkspace: boolean; hasPublishableLib: boolean; hasUnsafeCode: boolean };
      enabledTools: string[];
      filesCreated: string[];
    };
    expect(payload.status).toBe("initialized");
    expect(payload.workspace.isCargoWorkspace).toBe(true);
    // Binary crate (`src/main.rs` only) -> semver is NOT auto-enabled
    expect(payload.workspace.hasPublishableLib).toBe(false);
    // Contains `unsafe` -> geiger IS auto-enabled
    expect(payload.workspace.hasUnsafeCode).toBe(true);
    expect(payload.enabledTools).toContain("deny");
    expect(payload.enabledTools).toContain("geiger");
    expect(payload.enabledTools).not.toContain("semver");

    expect(await Bun.file(join(dir, "deny.toml")).exists()).toBe(true);
    expect(await Bun.file(join(dir, ".github", "workflows", "peer.yml")).exists()).toBe(true);

    // First-adoption additive config: when baseSha has no peer.toml yet, local peer.toml additively enables deny & geiger
    const effectiveCfg = await loadPeerConfig(dir, baseSha);
    expect(effectiveCfg.tools.deny).toBe(true);
    expect(effectiveCfg.tools.geiger).toBe(true);
    expect(effectiveCfg.tools.clippy).toBe(true);
    expect(effectiveCfg.tools.audit).toBe(true);
  });
});
