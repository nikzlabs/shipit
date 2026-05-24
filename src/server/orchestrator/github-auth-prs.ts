/**
 * GitHub pull request operations — extracted from GitHubAuthManager.
 * Functions in this module handle PR creation, lookup, merge, and auto-merge.
 */

import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, fetchGitHubGraphQL, parseGitHubError } from "./github-api.js";

/**
 * Create a pull request on GitHub.
 * Returns the PR URL on success, or an error message.
 */
export async function createPullRequest(
  token: string,
  options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  },
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: options.title,
          body: options.body,
          head: options.head,
          base: options.base,
          draft: options.draft ?? false,
        }),
      },
    );

    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }

    const data = (await res.json()) as { html_url: string; number: number };
    return {
      success: true,
      url: data.html_url,
      number: data.number,
    };
  } catch (err) {
    return {
      success: false,
      message: getErrorMessage(err),
    };
  }
}

/**
 * Check if an open PR exists for the given head branch.
 * Returns PR metadata if found, null otherwise.
 */
export async function findPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{ url: string; number: number; base: string; title: string; body: string } | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`,
    token,
  );

  if (!res.ok) return null;
  const prs = (await res.json()) as { html_url: string; number: number; base: { ref: string }; title: string; body: string | null }[];
  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    title: pr.title,
    body: pr.body ?? "",
  };
}

/**
 * Check if a PR exists for the given head branch in any state (open, closed, merged).
 * Used as a one-time catch-up probe after server restart to detect already-merged PRs.
 */
export async function findPullRequestAnyState(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{
  url: string; number: number; base: string; title: string; body: string;
  state: "open" | "closed"; merged_at: string | null;
  additions: number; deletions: number;
} | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=all&sort=updated&direction=desc&per_page=1`,
    token,
  );

  if (!res.ok) return null;
  const prs = (await res.json()) as {
    html_url: string; number: number; base: { ref: string }; title: string; body: string | null;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  }[];
  if (prs.length === 0) return null;

  const pr = prs[0];

  // The list endpoint may not include additions/deletions — fetch the individual PR for accurate stats.
  let additions = pr.additions ?? 0;
  let deletions = pr.deletions ?? 0;
  if (!additions && !deletions) {
    try {
      const detailRes = await fetchGitHub(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`,
        token,
      );
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as { additions: number; deletions: number };
        additions = detail.additions ?? 0;
        deletions = detail.deletions ?? 0;
      }
    } catch {
      // Fall back to zero stats
    }
  }

  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    merged_at: pr.merged_at,
    additions,
    deletions,
  };
}

/**
 * Merge a pull request.
 *
 * `commitTitle` and `commitMessage` override the squash/merge commit's subject
 * and body. When omitted, GitHub falls back to the repo's "Default commit
 * message" setting (Settings → General → Pull Requests), which on older repos
 * defaults to "Default to commit messages" — i.e., concatenates every original
 * commit. Callers should pass the PR title (and ideally body) so behavior is
 * independent of per-repo settings.
 */
export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
  commitTitle?: string,
  commitMessage?: string,
): Promise<{ success: boolean; message: string }> {
  const body: Record<string, string> = { merge_method: method };
  if (typeof commitTitle === "string") body.commit_title = commitTitle;
  if (typeof commitMessage === "string") body.commit_message = commitMessage;

  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = (await res.json()) as { message?: string };
    if (res.status === 405) {
      return { success: false, message: err.message || "PR is not mergeable" };
    }
    return { success: false, message: err.message || `GitHub API returned ${res.status}` };
  }

  return { success: true, message: "Pull request merged" };
}

/**
 * Enable auto-merge on a pull request.
 * Uses the GraphQL API since REST doesn't support auto-merge.
 *
 * Always passes the PR's title and body as `commitHeadline`/`commitBody` so
 * that when GitHub eventually performs the squash, the resulting commit
 * matches the PR — independent of the repo's "Default commit message" setting.
 * The title and body are read from the same PR fetch we already need for the
 * node_id, so this adds no extra network round-trip.
 */
export async function enableAutoMerge(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
): Promise<{ success: boolean; message: string }> {
  // First, get the PR's node ID + title + body (needed for GraphQL)
  const prRes = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );

  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = (await prRes.json()) as {
    node_id: string;
    title: string;
    body: string | null;
  };
  const nodeId = prData.node_id;
  const commitHeadline = prData.title;
  const commitBody = prData.body ?? "";

  // Enable auto-merge via GraphQL. Pass commitHeadline/commitBody so the
  // eventual squash commit uses the PR title/body rather than the repo's
  // "Default commit message" setting (which on older repos concatenates
  // every original commit message).
  const graphqlRes = await fetchGitHubGraphQL(
    token,
    `mutation EnableAutoMerge(
      $prId: ID!,
      $method: PullRequestMergeMethod!,
      $commitHeadline: String,
      $commitBody: String,
    ) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $prId,
        mergeMethod: $method,
        commitHeadline: $commitHeadline,
        commitBody: $commitBody,
      }) {
        pullRequest { autoMergeRequest { enabledAt } }
      }
    }`,
    { prId: nodeId, method, commitHeadline, commitBody },
  );

  if (!graphqlRes.ok) return { success: false, message: "Failed to enable auto-merge" };
  const graphqlData = (await graphqlRes.json()) as { errors?: { message: string }[] };

  if (graphqlData.errors) {
    const errMsg = graphqlData.errors[0]?.message ?? "Unknown error";
    if (errMsg.includes("auto-merge")) {
      return { success: false, message: "Auto-merge is not enabled for this repository. Enable it in repo Settings > General." };
    }
    return { success: false, message: errMsg };
  }

  return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
}

/**
 * Update an existing pull request (title and/or body).
 * Pass `state: "open" | "closed"` to reopen/close.
 */
export async function updatePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  options: { title?: string; body?: string; state?: "open" | "closed" },
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  try {
    const payload: Record<string, string> = {};
    if (typeof options.title === "string") payload.title = options.title;
    if (typeof options.body === "string") payload.body = options.body;
    if (options.state) payload.state = options.state;
    if (Object.keys(payload).length === 0) {
      return { success: false, message: "No fields to update" };
    }

    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      token,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }

    const data = (await res.json()) as { html_url: string; number: number };
    return { success: true, url: data.html_url, number: data.number };
  } catch (err) {
    return { success: false, message: getErrorMessage(err) };
  }
}

/**
 * Add an issue-style comment to a pull request. Uses the issues API endpoint
 * since PRs are issues on GitHub. Returns the comment URL on success.
 */
export async function addPullRequestComment(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<{ success: boolean; url?: string; message?: string }> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );

    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }

    const data = (await res.json()) as { html_url: string };
    return { success: true, url: data.html_url };
  } catch (err) {
    return { success: false, message: getErrorMessage(err) };
  }
}

/**
 * Mark a draft pull request as ready for review.
 * Uses the GraphQL API since REST does not expose this transition.
 */
export async function markPullRequestReady(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ success: boolean; message: string }> {
  // Get the PR's node ID
  const prRes = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = (await prRes.json()) as { node_id: string };
  const nodeId = prData.node_id;

  const graphqlRes = await fetchGitHubGraphQL(
    token,
    `mutation MarkReady($prId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $prId }) {
        pullRequest { isDraft }
      }
    }`,
    { prId: nodeId },
  );

  if (!graphqlRes.ok) return { success: false, message: "Failed to mark PR ready" };
  const graphqlData = (await graphqlRes.json()) as { errors?: { message: string }[] };
  if (graphqlData.errors) {
    return { success: false, message: graphqlData.errors[0]?.message ?? "Unknown error" };
  }
  return { success: true, message: "Pull request marked ready for review" };
}

/**
 * List open pull requests for a repository.
 * Returns a small array of PR metadata sorted by most recently updated.
 */
export async function listPullRequests(
  token: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open",
): Promise<{ url: string; number: number; base: string; title: string; state: "open" | "closed"; isDraft: boolean; head: string }[]> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=30`,
    token,
  );
  if (!res.ok) return [];
  const prs = (await res.json()) as {
    html_url: string;
    number: number;
    base: { ref: string };
    head: { ref: string };
    title: string;
    state: "open" | "closed";
    draft: boolean;
  }[];
  return prs.map((pr) => ({
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    head: pr.head.ref,
    title: pr.title,
    state: pr.state,
    isDraft: pr.draft,
  }));
}

/**
 * Fetch a single pull request's details.
 */
export async function viewPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{
  url: string; number: number; base: string; head: string;
  title: string; body: string;
  state: "open" | "closed"; isDraft: boolean; merged: boolean;
  additions: number; deletions: number;
} | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  if (!res.ok) return null;
  const pr = (await res.json()) as {
    html_url: string; number: number;
    base: { ref: string }; head: { ref: string };
    title: string; body: string | null;
    state: "open" | "closed"; draft: boolean; merged: boolean;
    additions: number; deletions: number;
  };
  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    head: pr.head.ref,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    isDraft: pr.draft,
    merged: pr.merged,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

/** Fetch the GraphQL node id for a pull request. */
export async function getPullRequestNodeId(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  if (!res.ok) return null;
  const pr = (await res.json()) as { node_id?: string };
  return pr.node_id ?? null;
}

/**
 * Disable auto-merge on a pull request.
 * Uses the GraphQL API (`disablePullRequestAutoMerge` mutation).
 */
export async function disableAutoMerge(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ success: boolean; message: string }> {
  // Get the PR's node ID
  const prRes = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );

  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = (await prRes.json()) as { node_id: string };
  const nodeId = prData.node_id;

  const graphqlRes = await fetchGitHubGraphQL(
    token,
    `mutation DisableAutoMerge($prId: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $prId }) {
        pullRequest { autoMergeRequest { enabledAt } }
      }
    }`,
    { prId: nodeId },
  );

  if (!graphqlRes.ok) return { success: false, message: "Failed to disable auto-merge" };
  const graphqlData = (await graphqlRes.json()) as { errors?: { message: string }[] };

  if (graphqlData.errors) {
    return { success: false, message: graphqlData.errors[0]?.message ?? "Unknown error" };
  }

  return { success: true, message: "Auto-merge disabled" };
}
