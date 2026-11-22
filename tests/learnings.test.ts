import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptLearningStoreError,
  formatLearningsPromptSection,
  LearningStore,
} from "../src/learnings.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Persistent repository learning store", () => {
  test("LearningStore adds, lists, matches by file scope glob, and removes learnings", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-learnings-test-"));
    tempDirs.push(repo);

    const store = new LearningStore(repo);
    expect(await store.list()).toEqual([]);

    const globalRule = await store.add({
      rule: "EngineState.account and ledger.account are reconciled at barrier checkpoints; dual snapshots are intentional.",
    });
    const scopedRule = await store.add({
      rule: "Allow .expect() on primary_spec() in OMS kernel because specs are validated non-empty at construction.",
      scope: "src/oms/**",
    });
    const otherScopedRule = await store.add({
      rule: "Dhan websocket binary parser uses little-endian fixed frames.",
      scope: "src/exchange/dhan/**",
    });

    const all = await store.list();
    expect(all.length).toBe(3);

    // Matching for a PR that modifies src/oms/kernel.rs
    const matched = await store.getMatchingLearnings(["src/oms/kernel.rs"]);
    expect(matched.map((m) => m.id)).toEqual([globalRule.id, scopedRule.id]);

    const section = formatLearningsPromptSection(matched);
    expect(section).toContain("EngineState.account");
    expect(section).toContain("primary_spec()");
    expect(section).not.toContain("Dhan websocket");

    // Removing a rule
    const removed = await store.remove(otherScopedRule.id);
    expect(removed).toBe(true);
    expect((await store.list()).length).toBe(2);
  });

  test("F-10 & F-11: LearningStore matches zero-segment ** globs and brace expansion via Bun.Glob and throws CorruptLearningStoreError on malformed learnings.json", async () => {
    const repo = await mkdtemp(join(tmpdir(), "peer-learnings-glob-"));
    tempDirs.push(repo);

    const store = new LearningStore(repo);
    await store.add({
      rule: "Zero-segment glob rule",
      scope: "src/**/*.rs",
    });
    await store.add({
      rule: "Brace expansion rule",
      scope: "crates/{oms,core}/**/*.rs",
    });

    // F-11: `src/**/*.rs` must match zero-segment `src/lib.rs` as well as `src/sub/mod.rs`
    const matchedRoot = await store.getMatchingLearnings(["src/lib.rs"]);
    expect(matchedRoot.map((m) => m.rule)).toEqual(["Zero-segment glob rule"]);

    // F-11: `crates/{oms,core}/**/*.rs` must match `crates/oms/src/lib.rs`
    const matchedBraces = await store.getMatchingLearnings(["crates/oms/src/lib.rs"]);
    expect(matchedBraces.map((m) => m.rule)).toEqual(["Brace expansion rule"]);

    // F-10: Corrupt learnings.json must throw CorruptLearningStoreError instead of silently wiping on add()
    await mkdir(join(repo, ".git", "peer"), { recursive: true });
    await writeFile(store.getLearningsPath(), "{ corrupt json");

    await expect(store.list()).rejects.toThrow(CorruptLearningStoreError);
    await expect(store.add({ rule: "Should not overwrite corrupt file" })).rejects.toThrow(
      CorruptLearningStoreError,
    );
  });
});
