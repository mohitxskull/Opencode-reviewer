import { Octokit } from "@octokit/rest";

import {
  type DiffFileMap,
  isValidInlineRange,
  PEER_REVIEW_MARKER,
  type PullRequestMetadata,
  PullRequestMetadataSchema,
  type PullRequestSummary,
  PullRequestSummarySchema,
  WALKTHROUGH_MARKER,
} from "../domain/models.ts";

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class ExistingManualPendingReviewError extends Error {
  public readonly reviewId: number;

  constructor(reviewId: number, prNumber: number) {
    super(
      `Found an existing manual PENDING draft review (id=${reviewId}) on PR #${prNumber} that was not created by peer. Submit or discard your manual draft review on GitHub before running 'peer publish'.`,
    );
    this.name = "ExistingManualPendingReviewError";
    this.reviewId = reviewId;
  }
}

const PEER_SECRET_SERVICE = "peer-cli";
const PEER_GITHUB_SECRET_NAME = "github-token";

async function defaultKeychainTokenReader(): Promise<string | null> {
  try {
    return await Bun.secrets.get({
      service: PEER_SECRET_SERVICE,
      name: PEER_GITHUB_SECRET_NAME,
    });
  } catch {
    // Headless Linux without libsecret daemon — fall through cleanly
    return null;
  }
}

async function defaultGhAuthTokenRunner(): Promise<string> {
  if (!Bun.which("gh")) {
    throw new Error("gh CLI not found in PATH");
  }
  const proc = Bun.spawnSync(["gh", "auth", "token"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || "gh auth token failed");
  }
  return proc.stdout.toString();
}

export async function resolveGitHubToken(
  env: Record<string, string | undefined> = process.env,
  ghTokenRunner: () => Promise<string> = defaultGhAuthTokenRunner,
  keychainReader: () => Promise<string | null> = defaultKeychainTokenReader,
): Promise<string> {
  const peerToken = env.PEER_GITHUB_TOKEN?.trim();
  if (peerToken) {
    return peerToken;
  }

  const ghEnvToken = env.GITHUB_TOKEN?.trim();
  if (ghEnvToken) {
    return ghEnvToken;
  }

  try {
    const keychainToken = (await keychainReader())?.trim();
    if (keychainToken && keychainToken.length > 0) {
      return keychainToken;
    }
  } catch {
    // Fall through to gh CLI
  }

  try {
    const cliToken = (await ghTokenRunner()).trim();
    if (cliToken.length > 0) {
      return cliToken;
    }
  } catch {
    // Fall through to GitHubAuthError below
  }

  throw new GitHubAuthError(
    "Unable to resolve GitHub authentication token. Set PEER_GITHUB_TOKEN, GITHUB_TOKEN, store it in OS keychain (Bun.secrets), or log in via `gh auth login`.",
  );
}

export function parsePrTarget(
  target: string,
  defaultOwner: string,
  defaultRepo: string,
): { owner: string; repo: string; prNumber: number } {
  const trimmed = target.trim();

  // Plain or #-prefixed number: "42" or "#42"
  const numMatch = /^#?(\d+)$/.exec(trimmed);
  if (numMatch?.[1]) {
    const prNumber = Number.parseInt(numMatch[1], 10);
    if (prNumber >= 1) {
      return { owner: defaultOwner, repo: defaultRepo, prNumber };
    }
  }

  // Full GitHub PR URL: https://github.com/<owner>/<repo>/pull/<number>(/...)
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "github.com") {
      const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
      const prSegment = segments[3] ?? "";
      if (
        segments.length >= 4 &&
        segments[2] === "pull" &&
        segments[0] &&
        segments[1] &&
        /^\d+$/.test(prSegment)
      ) {
        const prNumber = Number.parseInt(prSegment, 10);
        if (Number.isInteger(prNumber) && prNumber >= 1) {
          return {
            owner: segments[0],
            repo: segments[1],
            prNumber,
          };
        }
      }
    }
  } catch {
    // Fall through to error
  }

  throw new Error(
    `Invalid PR target "${target}". Expected a PR number (e.g. 42, #42) or GitHub PR URL (https://github.com/owner/repo/pull/42).`,
  );
}

export interface InlineReviewCommentInput {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
}

export interface PostPrReviewOptions {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commitId: string;
  readonly comments: readonly InlineReviewCommentInput[];
  readonly diffMap?: Readonly<Record<string, DiffFileMap>>;
  readonly submit?: boolean;
  readonly summaryBody?: string;
}

export interface GitHubClientOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(options: GitHubClientOptions) {
    this.octokit = new Octokit({
      auth: options.token,
      baseUrl: options.baseUrl,
      request: options.fetch ? { fetch: options.fetch } : undefined,
    });
  }

  public async listOpenPrs(owner: string, repo: string, limit = 20): Promise<PullRequestSummary[]> {
    const response = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: limit,
      sort: "updated",
      direction: "desc",
    });

    return response.data.map((pr) =>
      PullRequestSummarySchema.parse({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "unknown",
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        htmlUrl: pr.html_url,
        updatedAt: pr.updated_at,
      }),
    );
  }

  public async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestMetadata> {
    const response = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    const pr = response.data;
    return PullRequestMetadataSchema.parse({
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      headRefName: pr.head.ref,
      baseRefName: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      htmlUrl: pr.html_url,
      updatedAt: pr.updated_at,
    });
  }

  public async getPullRequestDiff(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<string> {
    const response = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: {
        format: "diff",
      },
    });
    return typeof response.data === "string" ? response.data : String(response.data);
  }

  public async upsertWalkthroughComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<number> {
    const ensuredBody = body.includes(WALKTHROUGH_MARKER) ? body : `${WALKTHROUGH_MARKER}\n${body}`;

    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existing = comments.find((c) => c.body?.includes(WALKTHROUGH_MARKER));
    if (existing) {
      const updated = await this.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body: ensuredBody,
      });
      return updated.data.id;
    }

    const created = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: ensuredBody,
    });
    return created.data.id;
  }

  // Why: On GitHub REST API v3, omitting the `event` parameter in
  // `octokit.rest.pulls.createReview` creates a PENDING (draft) review visible
  // only to the authenticated developer until they review and submit it in the
  // GitHub UI (or pass --submit). Because GitHub allows only one PENDING
  // review per user per PR (returning HTTP 422 on a second POST), we delete any
  // prior PENDING review owned by the same user that carries `PEER_REVIEW_MARKER`
  // before creating a fresh one — leaving manually authored human PENDING drafts untouched.
  public async postPrReview(options: PostPrReviewOptions): Promise<number> {
    const me = await this.octokit.rest.users.getAuthenticated();
    const myLogin = me.data.login;

    const existingReviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      per_page: 100,
    });

    for (const review of existingReviews) {
      if (review.state === "PENDING" && review.user?.login === myLogin) {
        if (review.body?.includes(PEER_REVIEW_MARKER)) {
          await this.octokit.rest.pulls.deletePendingReview({
            owner: options.owner,
            repo: options.repo,
            pull_number: options.prNumber,
            review_id: review.id,
          });
        } else {
          throw new ExistingManualPendingReviewError(review.id, options.prNumber);
        }
      }
    }

    const rawSummary = options.summaryBody ?? "";
    const markedSummary = rawSummary.includes(PEER_REVIEW_MARKER)
      ? rawSummary
      : `${PEER_REVIEW_MARKER}\n${rawSummary}`.trim();

    const validComments = options.diffMap
      ? options.comments.filter((c) => {
          const fm = options.diffMap?.[c.path];
          return fm ? isValidInlineRange(fm, c.startLine, c.endLine) : false;
        })
      : options.comments;

    const formattedComments = validComments.map((c) => {
      if (c.startLine < c.endLine) {
        return {
          path: c.path,
          start_line: c.startLine,
          start_side: "RIGHT" as const,
          line: c.endLine,
          side: "RIGHT" as const,
          body: c.body,
        };
      }
      return {
        path: c.path,
        line: c.endLine,
        side: "RIGHT" as const,
        body: c.body,
      };
    });

    const createParams: Parameters<typeof this.octokit.rest.pulls.createReview>[0] = {
      owner: options.owner,
      repo: options.repo,
      pull_number: options.prNumber,
      commit_id: options.commitId,
      body: markedSummary,
      comments: formattedComments,
      ...(options.submit ? { event: "COMMENT" as const } : {}),
    };

    const created = await this.octokit.rest.pulls.createReview(createParams);
    return created.data.id;
  }
}
