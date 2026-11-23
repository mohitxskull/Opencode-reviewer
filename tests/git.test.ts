import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CheckpointStore,
  DirtyWorkingTreeError,
  ensureCleanWorkingTree,
  GitRemoteError,
  InPlaceCheckoutSession,
  parseGitHubOwnerRepo,
  resolveGitTopLevel,
  withInPlaceCheckout,
} from "../src/workspace/git.ts";

const tempDirs: string[] = [];

async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "peer-git-test-"));
  tempDirs.push(dir);

  const runGit = (args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
    }
    return res.stdout.toString().trim();
  };

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Test User"]);
  runGit(["config", "user.email", "test@example.com"]);

  await writeFile(join(dir, "README.md"), "# Initial\n");
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "initial commit"]);

  return dir;
}

function gitOutput(cwd: string, args: string[]): string {
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

describe("Task 02: Git session and checkpoint store", () => {
  test("parseGitHubOwnerRepo supports SSH and HTTPS remotes", () => {
    expect(parseGitHubOwnerRepo("git@github.com:tikv/tikv.git")).toEqual({
      owner: "tikv",
      repo: "tikv",
    });
    expect(parseGitHubOwnerRepo("https://github.com/tikv/tikv.git")).toEqual({
      owner: "tikv",
      repo: "tikv",
    });
    expect(parseGitHubOwnerRepo("https://github.com/tikv/tikv/")).toEqual({
      owner: "tikv",
      repo: "tikv",
    });
    expect(parseGitHubOwnerRepo("ssh://git@github.com/tikv/tikv.git")).toEqual({
      owner: "tikv",
      repo: "tikv",
    });

    expect(() => parseGitHubOwnerRepo("https://gitlab.com/tikv/tikv.git")).toThrow(GitRemoteError);
  });

  test("ensureCleanWorkingTree rejects staged, unstaged, and untracked files while ignoring .git/peer", async () => {
    const repo = await createTempGitRepo();

    // Writing inside .git/peer/ must not make the working tree dirty
    await mkdir(join(repo, ".git", "peer", "reviews", "pr-1"), { recursive: true });
    await writeFile(join(repo, ".git", "peer", "reviews", "pr-1", "checkpoint.json"), "{}");
    await ensureCleanWorkingTree(repo);

    // 1. Untracked file in working tree
    const untrackedPath = join(repo, "untracked.rs");
    await writeFile(untrackedPath, "fn main() {}\n");
    await expect(ensureCleanWorkingTree(repo)).rejects.toThrow(DirtyWorkingTreeError);
    await rm(untrackedPath);
    await ensureCleanWorkingTree(repo);

    // 2. Unstaged modification to tracked file
    await writeFile(join(repo, "README.md"), "# Modified\n");
    await expect(ensureCleanWorkingTree(repo)).rejects.toThrow(DirtyWorkingTreeError);

    // 3. Staged modification
    gitOutput(repo, ["add", "README.md"]);
    await expect(ensureCleanWorkingTree(repo)).rejects.toThrow(DirtyWorkingTreeError);
  });

  test("withInPlaceCheckout restores named branch on normal completion and thrown error", async () => {
    const repo = await createTempGitRepo();
    const baseSha = gitOutput(repo, ["rev-parse", "HEAD"]);

    // Create a second commit on a side branch to act as PR head
    gitOutput(repo, ["checkout", "-b", "feature-pr"]);
    await writeFile(join(repo, "lib.rs"), "pub fn added() -> u32 { 42 }\n");
    gitOutput(repo, ["add", "lib.rs"]);
    gitOutput(repo, ["commit", "-m", "pr commit"]);
    const prHeadSha = gitOutput(repo, ["rev-parse", "HEAD"]);

    // Switch back to main branch
    gitOutput(repo, ["checkout", "main"]);
    expect(gitOutput(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(baseSha);

    // 1. Normal completion
    const observedHead = await withInPlaceCheckout(
      { repoRoot: repo, targetSha: prHeadSha },
      async () => {
        return gitOutput(repo, ["rev-parse", "HEAD"]);
      },
    );
    expect(observedHead).toBe(prHeadSha);
    expect(gitOutput(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(baseSha);

    // 2. Thrown error inside callback still restores symbolic branch "main"
    await expect(
      withInPlaceCheckout({ repoRoot: repo, targetSha: prHeadSha }, async () => {
        expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(prHeadSha);
        throw new Error("Simulated lens failure");
      }),
    ).rejects.toThrow("Simulated lens failure");

    expect(gitOutput(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(baseSha);
  });

  test("InPlaceCheckoutSession restores detached HEAD when signal handler fires", async () => {
    const repo = await createTempGitRepo();
    const origSha = gitOutput(repo, ["rev-parse", "HEAD"]);

    await writeFile(join(repo, "second.txt"), "second\n");
    gitOutput(repo, ["add", "second.txt"]);
    gitOutput(repo, ["commit", "-m", "second"]);
    const prHeadSha = gitOutput(repo, ["rev-parse", "HEAD"]);

    // Start in detached HEAD state at origSha
    gitOutput(repo, ["checkout", "--detach", origSha]);
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(origSha);

    const session = new InPlaceCheckoutSession({ repoRoot: repo, targetSha: prHeadSha });
    await session.enter();
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(prHeadSha);

    // Trigger signal restoration directly without killing the test runner process
    session.restoreOnSignal();
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(origSha);
    await session.exit();
  });

  test("CheckpointStore resolves incremental range on fast-forward and falls back on force-push or fresh", async () => {
    const repo = await createTempGitRepo();
    const prBaseSha = gitOutput(repo, ["rev-parse", "HEAD"]);

    // First PR commit (v1)
    gitOutput(repo, ["checkout", "-b", "pr-branch"]);
    await writeFile(join(repo, "a.txt"), "v1\n");
    gitOutput(repo, ["add", "a.txt"]);
    gitOutput(repo, ["commit", "-m", "pr v1"]);
    const prHeadV1 = gitOutput(repo, ["rev-parse", "HEAD"]);

    // Second PR commit fast-forwarding from v1 (v2)
    await writeFile(join(repo, "a.txt"), "v2\n");
    gitOutput(repo, ["add", "a.txt"]);
    gitOutput(repo, ["commit", "-m", "pr v2"]);
    const prHeadV2 = gitOutput(repo, ["rev-parse", "HEAD"]);

    // Divergent commit directly off prBaseSha (simulating force-push v3)
    gitOutput(repo, ["checkout", "-b", "pr-force-pushed", prBaseSha]);
    await writeFile(join(repo, "b.txt"), "v3\n");
    gitOutput(repo, ["add", "b.txt"]);
    gitOutput(repo, ["commit", "-m", "pr v3 force push"]);
    const prHeadForcePushed = gitOutput(repo, ["rev-parse", "HEAD"]);

    const store = new CheckpointStore(repo);
    await store.save({
      prNumber: 42,
      baseSha: prBaseSha,
      lastReviewedHeadSha: prHeadV1,
      reviewedAt: new Date().toISOString(),
      profile: "chill",
    });

    // 1. Fast-forward commit uses incremental base (prHeadV1)
    const fastForwardResolution = await store.resolveDiffBase({
      prNumber: 42,
      prBaseSha,
      currentHeadSha: prHeadV2,
      fresh: false,
    });
    expect(fastForwardResolution).toEqual({
      diffBaseSha: prHeadV1,
      isIncremental: true,
    });

    // 2. --fresh flag forces full prBaseSha review
    const freshResolution = await store.resolveDiffBase({
      prNumber: 42,
      prBaseSha,
      currentHeadSha: prHeadV2,
      fresh: true,
    });
    expect(freshResolution).toEqual({
      diffBaseSha: prBaseSha,
      isIncremental: false,
    });

    // 3. Force-pushed commit where prHeadV1 is not an ancestor falls back to prBaseSha
    const forcePushResolution = await store.resolveDiffBase({
      prNumber: 42,
      prBaseSha,
      currentHeadSha: prHeadForcePushed,
      fresh: false,
    });
    expect(forcePushResolution).toEqual({
      diffBaseSha: prBaseSha,
      isIncremental: false,
    });

    // 4. Profile change invalidates incremental reuse and triggers full PR diff
    const profileMismatchResolution = await store.resolveDiffBase({
      prNumber: 42,
      prBaseSha,
      currentHeadSha: prHeadV2,
      fresh: false,
      profile: "assertive",
    });
    expect(profileMismatchResolution).toEqual({
      diffBaseSha: prBaseSha,
      isIncremental: false,
    });

    // 5. resolveGitTopLevel normalizes nested subdirectory to git repository root
    const nestedDir = join(repo, "crates", "sub");
    await mkdir(nestedDir, { recursive: true });
    expect(resolveGitTopLevel(nestedDir)).toBe(repo);
  });

  test("F-10: CheckpointStore resolves common git dir inside a linked git worktree where .git is a file", async () => {
    const mainRepo = await createTempGitRepo();
    const worktreeDir = await mkdtemp(join(tmpdir(), "peer-git-wt-"));
    tempDirs.push(worktreeDir);
    await rm(worktreeDir, { recursive: true, force: true });

    gitOutput(mainRepo, ["worktree", "add", "-b", "wt-branch", worktreeDir]);

    const store = new CheckpointStore(worktreeDir);
    const headSha = gitOutput(worktreeDir, ["rev-parse", "HEAD"]);
    await store.save({
      prNumber: 77,
      baseSha: headSha,
      lastReviewedHeadSha: headSha,
      reviewedAt: new Date().toISOString(),
      profile: "assertive",
    });

    const loaded = await store.load(77);
    expect(loaded?.prNumber).toBe(77);
    expect(loaded?.lastReviewedHeadSha).toBe(headSha);
  });

  test("RC-01 & RC-02: rejects git option injection in SHAs/refs and symlink escapes in .peer/", async () => {
    const repo = await createTempGitRepo();
    const { assertSafeGitSha, assertSafeGitRef, assertContainedNonSymlinkDir } =
      await import("../src/workspace/git.ts");

    expect(() => assertSafeGitSha("--upload-pack=touch /tmp/pwn")).toThrow();
    expect(() => assertSafeGitSha("../../etc/passwd")).toThrow();
    expect(() => assertSafeGitRef("--upload-pack=touch /tmp/pwn")).toThrow();
    expect(() => assertSafeGitRef("refs/heads/main..evil")).toThrow();
    expect(assertSafeGitSha("dcf6f7e45b784af475641d7a6b1fc7a09e3c2dac")).toBe(
      "dcf6f7e45b784af475641d7a6b1fc7a09e3c2dac",
    );
    expect(assertSafeGitRef("feat/rust-reviewer")).toBe("feat/rust-reviewer");

    const { symlinkSync } = await import("node:fs");
    const outsideDir = await mkdtemp(join(tmpdir(), "peer-outside-"));
    tempDirs.push(outsideDir);
    symlinkSync(outsideDir, join(repo, ".peer"));

    expect(() => assertContainedNonSymlinkDir(repo, join(repo, ".peer", "1", "dcf6f7e"))).toThrow(
      /Refusing to follow symbolic link/,
    );
  });
});
