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
