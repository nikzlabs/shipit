/**
 * GitHub pull request operations — extracted from GitHubAuthManager.
 * Functions in this module handle PR creation, lookup, merge, and auto-merge.
 */

import { getErrorMessage } from "../shared/utils.js";

const GITHUB_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "ShipIt",
});

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
    const res = await fetch(
      `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`,
      {
        method: "POST",
        headers: {
          ...GITHUB_HEADERS(token),
          "Content-Type": "application/json",
        },
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
      const err = (await res.json()) as { message?: string };
      return { success: false, message: err.message || `GitHub API returned ${res.status}` };
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
): Promise<{ url: string; number: number; base: string; title: string } | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`,
    { headers: GITHUB_HEADERS(token) },
  );

  if (!res.ok) return null;
  const prs = (await res.json()) as { html_url: string; number: number; base: { ref: string }; title: string }[];
  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    title: pr.title,
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
  url: string; number: number; base: string; title: string;
  state: "open" | "closed"; merged_at: string | null;
  additions: number; deletions: number;
} | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=all&sort=updated&direction=desc&per_page=1`,
    { headers: GITHUB_HEADERS(token) },
  );

  if (!res.ok) return null;
  const prs = (await res.json()) as {
    html_url: string; number: number; base: { ref: string }; title: string;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  }[];
  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    title: pr.title,
    state: pr.state,
    merged_at: pr.merged_at,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

/**
 * Merge a pull request.
 */
export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
): Promise<{ success: boolean; message: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    {
      method: "PUT",
      headers: {
        ...GITHUB_HEADERS(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: method }),
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
 */
export async function enableAutoMerge(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
): Promise<{ success: boolean; message: string }> {
  // First, get the PR's node ID (needed for GraphQL)
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    { headers: GITHUB_HEADERS(token) },
  );

  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = (await prRes.json()) as { node_id: string };
  const nodeId = prData.node_id;

  // Enable auto-merge via GraphQL
  const graphqlRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ShipIt",
    },
    body: JSON.stringify({
      query: `mutation EnableAutoMerge($prId: ID!, $method: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
          pullRequest { autoMergeRequest { enabledAt } }
        }
      }`,
      variables: { prId: nodeId, method },
    }),
  });

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
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    { headers: GITHUB_HEADERS(token) },
  );

  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = (await prRes.json()) as { node_id: string };
  const nodeId = prData.node_id;

  const graphqlRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ShipIt",
    },
    body: JSON.stringify({
      query: `mutation DisableAutoMerge($prId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $prId }) {
          pullRequest { autoMergeRequest { enabledAt } }
        }
      }`,
      variables: { prId: nodeId },
    }),
  });

  if (!graphqlRes.ok) return { success: false, message: "Failed to disable auto-merge" };
  const graphqlData = (await graphqlRes.json()) as { errors?: { message: string }[] };

  if (graphqlData.errors) {
    return { success: false, message: graphqlData.errors[0]?.message ?? "Unknown error" };
  }

  return { success: true, message: "Auto-merge disabled" };
}
