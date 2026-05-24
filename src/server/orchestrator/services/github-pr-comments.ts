/**
 * PR review-thread comment-sync services (docs/102).
 *
 * Three pure functions composed by the HTTP routes layer:
 *   - replyToReviewThread(threadId, body)
 *   - resolveReviewThread(threadId)
 *   - unresolveReviewThread(threadId)
 *
 * Each enforces the `prCommentSync` feature flag in the CredentialStore — when
 * the flag is off the service throws `ServiceError(403, …)` so the route
 * returns a 403. The read side (the poller fetching `reviewThreads` on the
 * GraphQL query) ships unconditionally with docs/133 Phase 4 and is not gated
 * by this flag.
 *
 * Pulling the existence check into the service keeps both the HTTP routes and
 * any future WS handler that wants to call these in sync without duplicating
 * the flag check.
 */

import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { GitManager } from "../../shared/git.js";
import { parseGitHubRemote } from "../git-utils.js";
import { ServiceError } from "./types.js";

function ensureEnabled(credentialStore: CredentialStore): void {
  if (!credentialStore.getPrCommentSync()) {
    throw new ServiceError(403, "PR comment sync is disabled. Enable it in Settings.");
  }
}

function ensureAuthenticated(githubAuthManager: GitHubAuthManager): void {
  if (!githubAuthManager.authenticated) {
    throw new ServiceError(401, "Not authenticated with GitHub");
  }
}

function ensureThreadId(threadId: unknown): asserts threadId is string {
  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    throw new ServiceError(400, "Review thread id is required");
  }
}

export interface PullRequestReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

function ensureReviewComments(comments: unknown): PullRequestReviewCommentInput[] {
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new ServiceError(400, "At least one review comment is required");
  }
  if (comments.length > 100) {
    throw new ServiceError(400, "A review can include at most 100 comments");
  }

  return comments.map((comment, index) => {
    if (!comment || typeof comment !== "object") {
      throw new ServiceError(400, `Review comment ${index + 1} is invalid`);
    }
    const value = comment as { path?: unknown; line?: unknown; body?: unknown };
    const path = typeof value.path === "string" ? value.path.trim() : "";
    const line = typeof value.line === "number" ? value.line : Number.NaN;
    const body = typeof value.body === "string" ? value.body.trim() : "";
    if (!path) throw new ServiceError(400, `Review comment ${index + 1} path is required`);
    if (!Number.isInteger(line) || line <= 0) {
      throw new ServiceError(400, `Review comment ${index + 1} line must be a positive integer`);
    }
    if (!body) throw new ServiceError(400, `Review comment ${index + 1} body is required`);
    return { path, line, body };
  });
}

async function resolveGitHubRemote(
  git: GitManager,
  remoteUrl?: string,
): Promise<{ owner: string; repo: string }> {
  if (remoteUrl) {
    const parsed = parseGitHubRemote(remoteUrl);
    if (parsed) return parsed;
  }

  const origin = (await git.getRemotes()).find((remote) => remote.name === "origin");
  if (!origin) throw new ServiceError(400, "No 'origin' remote configured");
  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) throw new ServiceError(400, "Remote URL is not a GitHub repository");
  return parsed;
}

/**
 * Reply to an existing PR review thread.
 *
 * `threadId` is the GraphQL node id surfaced as `PrReviewThread.id` on the
 * client. The new comment is attributed to the orchestrator's GitHub token
 * owner.
 */
export async function replyToReviewThread(
  credentialStore: CredentialStore,
  githubAuthManager: GitHubAuthManager,
  threadId: string,
  body: string,
): Promise<{ success: boolean; message: string }> {
  ensureEnabled(credentialStore);
  ensureAuthenticated(githubAuthManager);
  ensureThreadId(threadId);
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) throw new ServiceError(400, "Reply body is required");

  const result = await githubAuthManager.addReviewThreadReply(threadId, trimmed);
  if (!result.success) {
    throw new ServiceError(502, result.message);
  }
  return result;
}

/** Mark a PR review thread as resolved. */
export async function resolveReviewThread(
  credentialStore: CredentialStore,
  githubAuthManager: GitHubAuthManager,
  threadId: string,
): Promise<{ success: boolean; message: string }> {
  ensureEnabled(credentialStore);
  ensureAuthenticated(githubAuthManager);
  ensureThreadId(threadId);

  const result = await githubAuthManager.resolveReviewThread(threadId);
  if (!result.success) {
    throw new ServiceError(502, result.message);
  }
  return result;
}

/** Reopen (unresolve) a previously-resolved review thread. */
export async function unresolveReviewThread(
  credentialStore: CredentialStore,
  githubAuthManager: GitHubAuthManager,
  threadId: string,
): Promise<{ success: boolean; message: string }> {
  ensureEnabled(credentialStore);
  ensureAuthenticated(githubAuthManager);
  ensureThreadId(threadId);

  const result = await githubAuthManager.unresolveReviewThread(threadId);
  if (!result.success) {
    throw new ServiceError(502, result.message);
  }
  return result;
}

/** Submit local diff comments to the current branch's PR as one GitHub review. */
export async function submitReviewComments(
  credentialStore: CredentialStore,
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
  comments: unknown,
  remoteUrl?: string,
): Promise<{ success: boolean; message: string; count: number }> {
  ensureEnabled(credentialStore);
  ensureAuthenticated(githubAuthManager);
  const reviewComments = ensureReviewComments(comments);

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (!pr) {
    throw new ServiceError(404, "No active PR for current branch");
  }

  const pullRequestId = await githubAuthManager.getPullRequestNodeId(resolved.owner, resolved.repo, pr.number);
  if (!pullRequestId) {
    throw new ServiceError(502, "Failed to fetch pull request id from GitHub");
  }

  const result = await githubAuthManager.submitPullRequestReview(
    pullRequestId,
    reviewComments.map((comment) => ({ ...comment, side: "RIGHT" as const })),
    `ShipIt review: ${reviewComments.length} comment${reviewComments.length === 1 ? "" : "s"}`,
  );
  if (!result.success) {
    throw new ServiceError(502, result.message);
  }
  return { ...result, count: reviewComments.length };
}
