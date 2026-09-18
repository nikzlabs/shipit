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

export interface PullRequestReviewThreadDraft {
  path: string;
  line: number;
  body: string;
  side?: "LEFT" | "RIGHT";
}

export async function submitPullRequestReview(
  token: string,
  pullRequestId: string,
  comments: PullRequestReviewThreadDraft[],
  body?: string,
): Promise<{ success: boolean; message: string }> {
  const threads = comments.map((comment) => ({
    path: comment.path,
    line: comment.line,
    body: comment.body,
    side: comment.side ?? "RIGHT",
  }));
  const res = await fetchGitHubGraphQL(
    token,
    `mutation SubmitPullRequestReview(
      $pullRequestId: ID!,
      $threads: [DraftPullRequestReviewThread!],
      $body: String,
    ) {
      addPullRequestReview(input: {
        pullRequestId: $pullRequestId,
        event: COMMENT,
        body: $body,
        threads: $threads,
      }) {
        pullRequestReview { id state url }
      }
    }`,
    { pullRequestId, threads, body },
  );
  return parseMutationResult(res, "submit pull request review");
}
