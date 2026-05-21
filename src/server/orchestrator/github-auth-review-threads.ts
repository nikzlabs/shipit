/**
 * GitHub PR review-thread mutations — extracted for docs/102
 * (GitHub PR Review Comment Sync).
 *
 * Three operations, all GraphQL:
 *
 * - `addPullRequestReviewThreadReply` — append a new comment to an existing
 *   thread. Used to reply to a teammate's line comment from inside ShipIt.
 * - `resolveReviewThread` — mark a thread as resolved.
 * - `unresolveReviewThread` — reverse of the above.
 *
 * Each function takes a raw token (matching the pattern of `github-auth-prs.ts`
 * etc.) so it can be wrapped by the `GitHubAuthManager` while still being
 * unit-testable in isolation. They share the `parseMutationResult` helper to
 * turn GitHub's `{ data, errors }` envelope into the `{ success, message }`
 * shape used by callers.
 */

import { fetchGitHubGraphQL } from "./github-api.js";
import { getErrorMessage } from "../shared/utils.js";

interface GraphQLEnvelope {
  data?: unknown;
  errors?: { message: string }[];
}

async function parseMutationResult(
  res: Response,
  label: string,
): Promise<{ success: boolean; message: string }> {
  if (!res.ok) {
    return { success: false, message: `Failed to ${label} (HTTP ${res.status})` };
  }
  let body: GraphQLEnvelope;
  try {
    body = (await res.json()) as GraphQLEnvelope;
  } catch (err) {
    return { success: false, message: `Failed to parse ${label} response: ${getErrorMessage(err)}` };
  }
  if (body.errors && body.errors.length > 0) {
    return { success: false, message: body.errors[0]?.message ?? `Failed to ${label}` };
  }
  return { success: true, message: `${label} succeeded` };
}

/**
 * Append a reply comment to an existing review thread.
 *
 * `threadId` is the GraphQL node id of the thread (the `id` field on
 * `PullRequestReviewThread` — same value the poller surfaces through
 * `PrReviewThread.id`). Comments posted this way are attributed to the token's
 * owner; there is no per-call author override.
 */
export async function addReviewThreadReply(
  token: string,
  threadId: string,
  body: string,
): Promise<{ success: boolean; message: string }> {
  const res = await fetchGitHubGraphQL(
    token,
    `mutation AddReviewThreadReply($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: $threadId,
        body: $body,
      }) {
        comment { id url }
      }
    }`,
    { threadId, body },
  );
  return parseMutationResult(res, "reply to review thread");
}

/** Mark a review thread as resolved. */
export async function resolveReviewThread(
  token: string,
  threadId: string,
): Promise<{ success: boolean; message: string }> {
  const res = await fetchGitHubGraphQL(
    token,
    `mutation ResolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  );
  return parseMutationResult(res, "resolve review thread");
}

/** Reopen (unresolve) a previously-resolved review thread. */
export async function unresolveReviewThread(
  token: string,
  threadId: string,
): Promise<{ success: boolean; message: string }> {
  const res = await fetchGitHubGraphQL(
    token,
    `mutation UnresolveReviewThread($threadId: ID!) {
      unresolveReviewThread(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`,
    { threadId },
  );
  return parseMutationResult(res, "unresolve review thread");
}
