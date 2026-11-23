import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { registerSignalCleanup, triggerSignalCleanup } from "./lifecycle.ts";
import { type ReviewCheckpoint, ReviewCheckpointSchema, type ReviewProfile } from "./models.ts";

// Why: Storing checkpoints and reports under .git/peer/reviews/pr-<number>/ keeps
// review state inside git's administrative directory so in-place branch checkouts
// never collide with generated files and `git status --porcelain` stays clean
// without modifying the user's .gitignore.
export function resolveGitTopLevel(dir: string): string {
  const res = tryGitSync(dir, ["rev-parse", "--show-toplevel"]);
  if (res.ok && res.stdout.length > 0) {
    return resolve(res.stdout);
  }
  return resolve(dir);
}

export function resolveGitCommonDir(repoRoot: string): string {
  const res = tryGitSync(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (res.ok && res.stdout.length > 0) {
    return isAbsolute(res.stdout) ? res.stdout : resolve(repoRoot, res.stdout);
  }
  return join(repoRoot, ".git");
}

export function resolvePeerStateDir(repoRoot: string): string {
  return join(resolveGitCommonDir(repoRoot), "peer");
}

export function resolvePeerReviewsDir(repoRoot: string, prNumber: number): string {
  return join(resolvePeerStateDir(repoRoot), "reviews", `pr-${prNumber}`);
}

export class GitRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRemoteError";
  }
}

export class DirtyWorkingTreeError extends Error {
  public readonly dirtyPaths: readonly string[];

  constructor(dirtyPaths: readonly string[]) {
    super(
      `Working tree has uncommitted or untracked changes (${dirtyPaths.join(", ")}). Commit or git stash before running peer.`,
    );
    this.name = "DirtyWorkingTreeError";
    this.dirtyPaths = dirtyPaths;
  }
}

export class GitCommandError extends Error {
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    this.name = "GitCommandError";
  }
}

export function runGitSync(repoRoot: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new GitCommandError(args, proc.stderr.toString());
  }
  return proc.stdout.toString().trim();
}

export function tryGitSync(
  repoRoot: string,
  args: readonly string[],
): { ok: boolean; stdout: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString().trim(),
  };
}

export function tryGitRawSync(
  repoRoot: string,
  args: readonly string[],
): { ok: boolean; stdout: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
  };
}

export function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "");

  // SSH shorthand: git@github.com:owner/repo(.git)
  const scpMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scpMatch?.[1] && scpMatch[2]) {
    return { owner: scpMatch[1], repo: scpMatch[2] };
  }

  // URL forms: https://github.com/owner/repo(.git) or ssh://git@github.com/owner/repo(.git)
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      throw new GitRemoteError(`Remote URL is not a github.com host: ${remoteUrl}`);
    }
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch (err) {
    if (err instanceof GitRemoteError) {
      throw err;
    }
  }

  throw new GitRemoteError(`Unable to parse GitHub owner/repo from remote URL: ${remoteUrl}`);
}

export function detectRepoOwnerAndName(
  repoRoot: string,
  remoteName = "origin",
): { owner: string; repo: string } {
  const remoteUrl = runGitSync(repoRoot, ["remote", "get-url", remoteName]);
  return parseGitHubOwnerRepo(remoteUrl);
}

export async function ensureCleanWorkingTree(repoRoot: string): Promise<void> {
  const output = runGitSync(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]);
  if (output.length === 0) {
    return;
  }
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) {
    throw new DirtyWorkingTreeError(lines);
  }
}

export interface CheckoutOptions {
  readonly repoRoot: string;
  readonly targetSha: string;
  readonly prNumber?: number;
  readonly remoteName?: string;
}

// Why: We check out the PR commit in-place (after verifying `git status --porcelain`
// is clean) rather than creating a `git worktree` because complex Rust repositories
// have 10-80 GB `target/` build caches, git submodules (`-sys` crates), and IDE
// `rust-analyzer` file locks on `CARGO_TARGET_DIR`. In-place detached checkout
// reuses the warm `target/` directory at the exact same workspace path while
// guaranteeing restoration of the developer's original symbolic branch or SHA
// on normal completion, exception, or SIGINT/SIGTERM.
export class InPlaceCheckoutSession {
  private readonly options: CheckoutOptions;
  private originalRef: string | null = null;
  private hadCargoLockOnEntry = true;
  private restored = false;
  private unregisterCleanup: (() => void) | null = null;

  constructor(options: CheckoutOptions) {
    this.options = options;
  }

  public async enter(): Promise<void> {
    await ensureCleanWorkingTree(this.options.repoRoot);
    this.hadCargoLockOnEntry = await Bun.file(join(this.options.repoRoot, "Cargo.lock")).exists();

    const symRef = tryGitSync(this.options.repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (symRef.ok && symRef.stdout.length > 0) {
      this.originalRef = symRef.stdout;
    } else {
      this.originalRef = runGitSync(this.options.repoRoot, ["rev-parse", "--verify", "HEAD"]);
    }

    this.unregisterCleanup = registerSignalCleanup(() => {
      this.restoreOriginalRefSync();
    });

    try {
      const hasCommit = tryGitSync(this.options.repoRoot, [
        "cat-file",
        "-e",
        `${this.options.targetSha}^{commit}`,
      ]);
      if (!hasCommit.ok && this.options.prNumber !== undefined) {
        const remote = this.options.remoteName ?? "origin";
        runGitSync(this.options.repoRoot, [
          "fetch",
          "--no-tags",
          remote,
          `pull/${this.options.prNumber}/head`,
        ]);
      }

      runGitSync(this.options.repoRoot, ["checkout", "--detach", this.options.targetSha]);
    } catch (err) {
      this.restoreOriginalRefSync();
      this.removeSignalListeners();
      throw err;
    }
  }

  public restoreOnSignal(): void {
    triggerSignalCleanup();
    this.restoreOriginalRefSync();
  }

  public async exit(): Promise<void> {
    try {
      this.restoreOriginalRefSync();
    } finally {
      this.removeSignalListeners();
    }
  }

  private restoreOriginalRefSync(): void {
    if (this.restored || !this.originalRef) {
      return;
    }
    this.restored = true;
    runGitSync(this.options.repoRoot, ["checkout", "-f", this.originalRef]);
    if (!this.hadCargoLockOnEntry) {
      const trackedCheck = tryGitSync(this.options.repoRoot, [
        "ls-files",
        "--error-unmatch",
        "Cargo.lock",
      ]);
      if (!trackedCheck.ok) {
        try {
          rmSync(join(this.options.repoRoot, "Cargo.lock"), { force: true });
        } catch {
          // Ignore removal error if absent
        }
      }
    }
  }

  private removeSignalListeners(): void {
    if (this.unregisterCleanup) {
      this.unregisterCleanup();
      this.unregisterCleanup = null;
    }
  }
}

export async function withInPlaceCheckout<T>(
  options: CheckoutOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const session = new InPlaceCheckoutSession(options);
  await session.enter();
  try {
    return await fn();
  } finally {
    await session.exit();
  }
}

export interface ResolveDiffBaseOptions {
  readonly prNumber: number;
  readonly prBaseSha: string;
  readonly currentHeadSha: string;
  readonly fresh: boolean;
  readonly profile?: ReviewProfile;
}

export class CheckpointStore {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  public getPrReviewDir(prNumber: number): string {
    return resolvePeerReviewsDir(this.repoRoot, prNumber);
  }

  public getCheckpointPath(prNumber: number): string {
    return join(this.getPrReviewDir(prNumber), "checkpoint.json");
  }

  public async load(prNumber: number): Promise<ReviewCheckpoint | null> {
    const file = Bun.file(this.getCheckpointPath(prNumber));
    if (!(await file.exists())) {
      return null;
    }
    try {
      const raw: unknown = await file.json();
      return ReviewCheckpointSchema.parse(raw);
    } catch {
      return null;
    }
  }

  public async save(checkpoint: ReviewCheckpoint): Promise<void> {
    const validated = ReviewCheckpointSchema.parse(checkpoint);
    const dir = this.getPrReviewDir(validated.prNumber);
    await mkdir(dir, { recursive: true });
    const targetPath = this.getCheckpointPath(validated.prNumber);
    const tmpPath = `${targetPath}.${randomUUID().slice(0, 8)}.tmp`;
    await Bun.write(tmpPath, JSON.stringify(validated, null, 2));
    await rename(tmpPath, targetPath);
  }

  public async resolveDiffBase(
    options: ResolveDiffBaseOptions,
  ): Promise<{ diffBaseSha: string; isIncremental: boolean }> {
    if (options.fresh) {
      return { diffBaseSha: options.prBaseSha, isIncremental: false };
    }

    const existing = await this.load(options.prNumber);
    if (!existing) {
      return { diffBaseSha: options.prBaseSha, isIncremental: false };
    }

    if (
      existing.baseSha !== options.prBaseSha ||
      existing.lastReviewedHeadSha === options.currentHeadSha ||
      (options.profile !== undefined && existing.profile !== options.profile)
    ) {
      return { diffBaseSha: options.prBaseSha, isIncremental: false };
    }

    const ancestorCheck = tryGitSync(this.repoRoot, [
      "merge-base",
      "--is-ancestor",
      existing.lastReviewedHeadSha,
      options.currentHeadSha,
    ]);

    if (ancestorCheck.ok) {
      return { diffBaseSha: existing.lastReviewedHeadSha, isIncremental: true };
    }

    return { diffBaseSha: options.prBaseSha, isIncremental: false };
  }
}
