import { getErrorMessage } from "../shared/utils.js";
import { fetchGitHub, fetchGitHubGraphQL, parseGitHubError } from "./github-api.js";

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

export async function findPullRequestAnyState(
  token: string,
  owner: string,
  repo: string,
  head: string,
): Promise<{
  url: string; number: number; base: string; title: string; body: string;
  state: "open" | "closed"; merged_at: string | null; merge_commit_sha: string | null;
  head_sha: string | null; additions: number; deletions: number;
} | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=all&sort=updated&direction=desc&per_page=1`,
    token,
  );

  if (!res.ok) return null;
  const prs = (await res.json()) as {
    html_url: string; number: number; base: { ref: string }; title: string; body: string | null;
    state: "open" | "closed"; merged_at: string | null; merge_commit_sha: string | null;
    head: { sha: string } | null; additions: number; deletions: number;
  }[];
  if (prs.length === 0) return null;

  const pr = prs[0];

  // The list endpoint can omit change counts.
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
    merge_commit_sha: pr.merge_commit_sha ?? null,
    head_sha: pr.head?.sha ?? null,
    additions,
    deletions,
  };
}

export interface TerminalPrFacts {
  url: string; number: number; base: string; title: string; body: string;
  state: "open" | "closed"; merged_at: string | null; merge_commit_sha: string | null;
  head_sha: string | null; head_ref: string; additions: number; deletions: number;
}

// Settlement uses the PR number: a reused branch can point to a different PR.
export async function findPullRequestByNumber(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<TerminalPrFacts | null> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  if (!res.ok) return null;
  const pr = (await res.json().catch(() => null)) as {
    html_url?: string; number?: number; base?: { ref?: string }; title?: string; body?: string | null;
    state?: "open" | "closed"; merged_at?: string | null; merge_commit_sha?: string | null;
    head?: { sha?: string; ref?: string } | null; additions?: number; deletions?: number;
  } | null;
  if (!pr || typeof pr.number !== "number") return null;
  return {
    url: pr.html_url ?? "",
    number: pr.number,
    base: pr.base?.ref ?? "",
    title: pr.title ?? "",
    body: pr.body ?? "",
    state: pr.state === "closed" ? "closed" : "open",
    merged_at: pr.merged_at ?? null,
    merge_commit_sha: pr.merge_commit_sha ?? null,
    head_sha: pr.head?.sha ?? null,
    head_ref: pr.head?.ref ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
  };
}

export type MergeAttempt =
  | { outcome: "merged"; message: string; mergeCommitSha: string | null }
  | { outcome: "refused"; message: string }
  /** May have merged; retain the claim for reconciliation. */
  | { outcome: "indeterminate"; message: string };

// Pass expectedSha when approval applies to a specific commit.
export async function mergePullRequestAttempt(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
  commitTitle?: string,
  commitMessage?: string,
  expectedSha?: string,
): Promise<MergeAttempt> {
  const body: Record<string, string> = { merge_method: method };
  if (typeof commitTitle === "string") body.commit_title = commitTitle;
  if (typeof commitMessage === "string") body.commit_message = commitMessage;
  if (expectedSha) body.sha = expectedSha;

  let res: Response;
  try {
    res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      token,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    return {
      outcome: "indeterminate",
      message:
        `ShipIt did not hear back from GitHub about merging PR #${pullNumber} `
        + `(${err instanceof Error ? err.message : String(err)}). It may or may not have merged.`,
    };
  }

  if (!res.ok) {
    const message = await parseGitHubError(res);
    if (res.status >= 500 || res.status === 429) {
      return {
        outcome: "indeterminate",
        message: `GitHub returned ${res.status} for the merge of PR #${pullNumber}: ${message}`,
      };
    }
    if (res.status === 405) {
      return { outcome: "refused", message: message || "PR is not mergeable" };
    }
    if (res.status === 409 && expectedSha) {
      return {
        outcome: "refused",
        message:
          `${message || "Head branch was modified"} — the branch moved after its checks were `
          + "read, so nothing was merged. Merge again once the new head's checks report.",
      };
    }
    return { outcome: "refused", message };
  }

  const parsed = await res.json().catch(() => null) as {
    merged?: unknown; sha?: string; message?: unknown;
  } | null;
  if (!parsed) {
    return {
      outcome: "indeterminate",
      message: `GitHub accepted the merge of PR #${pullNumber} but returned a body ShipIt could not read.`,
    };
  }
  if (parsed.merged === true) {
    return { outcome: "merged", message: "Pull request merged", mergeCommitSha: parsed.sha ?? null };
  }
  if (parsed.merged === false) {
    const reason = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
    return {
      outcome: "refused",
      message: reason
        ? `GitHub reported the pull request as not merged: ${reason}`
        : "GitHub reported the pull request as not merged.",
    };
  }
  return {
    outcome: "indeterminate",
    message: `GitHub accepted the merge of PR #${pullNumber} but its answer did not say whether it merged.`,
  };
}

export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
  commitTitle?: string,
  commitMessage?: string,
  expectedSha?: string,
): Promise<{ success: boolean; message: string }> {
  const attempt = await mergePullRequestAttempt(
    token, owner, repo, pullNumber, method, commitTitle, commitMessage, expectedSha,
  );
  return { success: attempt.outcome === "merged", message: attempt.message };
}

export async function enableAutoMerge(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
): Promise<{ success: boolean; message: string }> {
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

  // Override repo defaults so the merge commit uses the PR title and body.
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
    const lower = errMsg.toLowerCase();
    if (lower.includes("auto-merge") || lower.includes("not allowed")) {
      return { success: false, message: "“Allow auto-merge” is turned off for this repository. Enable it in Settings → General → Pull Requests." };
    }
    if (lower.includes("clean status") || lower.includes("not in")) {
      return { success: false, message: "No branch protection rule requires a status check or review on the base branch, so there's nothing for auto-merge to wait on. Add a required check to the rule (or ruleset)." };
    }
    return { success: false, message: errMsg };
  }

  return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
}

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

export async function addLabelsToPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  labels: string[],
): Promise<{ success: boolean; message?: string }> {
  if (labels.length === 0) return { success: true };
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/labels`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
      },
    );
    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: getErrorMessage(err) };
  }
}

export async function removeLabelFromPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  label: string,
): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetchGitHub(
      `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/labels/${encodeURIComponent(label)}`,
      token,
      { method: "DELETE" },
    );
    if (res.status === 404) return { success: true };
    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }
    return { success: true };
  } catch (err) {
    return { success: false, message: getErrorMessage(err) };
  }
}

export async function markPullRequestReady(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ success: boolean; message: string }> {
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

export type PrListState = "open" | "closed" | "merged" | "all";

export const PR_LIST_STATES: readonly PrListState[] = ["open", "closed", "merged", "all"];

export interface ListedPullRequest {
  url: string;
  number: number;
  base: string;
  head: string;
  title: string;
  state: "open" | "closed";
  isDraft: boolean;
  mergedAt: string | null;
}

export type ListPullRequestsResult =
  | { ok: true; prs: ListedPullRequest[] }
  | { ok: false; error: string };

const PR_LIST_PAGE = 30;

const PR_LIST_MAX = 100;

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return PR_LIST_PAGE;
  return Math.min(Math.max(Math.trunc(limit), 1), PR_LIST_MAX);
}

// Filter merged PRs server-side; filtering one REST page can miss them all.
const MERGED_PRS_QUERY = `query($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: MERGED, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { url number title isDraft mergedAt baseRefName headRefName }
    }
  }
}`;

export async function listPullRequests(
  token: string,
  owner: string,
  repo: string,
  state: PrListState = "open",
  limit?: number,
): Promise<ListPullRequestsResult> {
  if (state === "merged") return listMergedPullRequests(token, owner, repo, limit);
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${pageSize(limit)}`,
    token,
  );
  if (!res.ok) return { ok: false, error: await parseGitHubError(res) };
  const prs = (await res.json()) as {
    html_url: string;
    number: number;
    base: { ref: string };
    head: { ref: string };
    title: string;
    state: "open" | "closed";
    draft: boolean;
    merged_at?: string | null;
  }[];
  return {
    ok: true,
    prs: prs.map((pr) => ({
      url: pr.html_url,
      number: pr.number,
      base: pr.base.ref,
      head: pr.head.ref,
      title: pr.title,
      state: pr.state,
      isDraft: pr.draft,
      mergedAt: pr.merged_at ?? null,
    })),
  };
}

async function listMergedPullRequests(
  token: string,
  owner: string,
  repo: string,
  limit?: number,
): Promise<ListPullRequestsResult> {
  const res = await fetchGitHubGraphQL(token, MERGED_PRS_QUERY, {
    owner, repo, first: pageSize(limit),
  });
  if (!res.ok) return { ok: false, error: await parseGitHubError(res) };
  const data = (await res.json()) as {
    errors?: { message: string }[];
    data?: {
      repository?: {
        pullRequests?: {
          nodes?: {
            url: string;
            number: number;
            title: string;
            isDraft: boolean;
            mergedAt: string | null;
            baseRefName: string;
            headRefName: string;
          }[];
        };
      };
    };
  };
  if (data.errors) return { ok: false, error: data.errors[0]?.message ?? "Unknown GraphQL error" };
  const nodes = data.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) {
    return { ok: false, error: "GitHub returned no pull request data for this repository" };
  }
  return {
    ok: true,
    prs: nodes.map((pr) => ({
      url: pr.url,
      number: pr.number,
      base: pr.baseRefName,
      head: pr.headRefName,
      title: pr.title,
      state: "closed" as const,
      isDraft: pr.isDraft,
      mergedAt: pr.mergedAt,
    })),
  };
}

export interface PullRequestDetail {
  url: string; number: number;
  base: string; head: string;
  baseRefName: string; headRefName: string;
  title: string; body: string;
  state: "open" | "closed"; isDraft: boolean; merged: boolean;
  additions: number; deletions: number;
  author: { login: string } | null;
  labels: { name: string; color: string; description: string }[];
  createdAt: string; updatedAt: string; mergedAt: string | null;
}

export async function viewPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDetail | null> {
  const result = await viewPullRequestResult(token, owner, repo, pullNumber);
  return result.ok ? result.pr : null;
}

export async function viewPullRequestResult(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ ok: true; pr: PullRequestDetail | null } | { ok: false; error: string }> {
  const res = await fetchGitHub(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token,
  );
  if (res.status === 404) return { ok: true, pr: null };
  if (!res.ok) return { ok: false, error: await parseGitHubError(res) };
  const pr = (await res.json()) as {
    html_url: string; number: number;
    base: { ref: string }; head: { ref: string };
    title: string; body: string | null;
    state: "open" | "closed"; draft: boolean; merged: boolean;
    additions: number; deletions: number;
    user?: { login?: string } | null;
    labels?: { name?: string; color?: string; description?: string | null }[] | null;
    created_at?: string; updated_at?: string; merged_at?: string | null;
  };
  return {
    ok: true,
    pr: {
      url: pr.html_url,
      number: pr.number,
      base: pr.base.ref,
      head: pr.head.ref,
      baseRefName: pr.base.ref,
      headRefName: pr.head.ref,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state,
      isDraft: pr.draft,
      merged: pr.merged,
      additions: pr.additions,
      deletions: pr.deletions,
      author: pr.user?.login ? { login: pr.user.login } : null,
      labels: (pr.labels ?? []).map((l) => ({
        name: l.name ?? "",
        color: l.color ?? "",
        description: l.description ?? "",
      })),
      createdAt: pr.created_at ?? "",
      updatedAt: pr.updated_at ?? "",
      mergedAt: pr.merged_at ?? null,
    },
  };
}

export interface PrConversationComment {
  id: string;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PrConversationReview {
  id: string;
  author: { login: string } | null;
  body: string;
  state: string;
  submittedAt: string;
  url: string;
}

export interface PrConversationThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  /** Current diff line; null for an outdated thread. */
  line: number | null;
  originalLine: number | null;
  diffHunk: string;
  comments: PrConversationComment[];
  commentsTotal: number;
}

export interface PrConversation {
  comments: PrConversationComment[];
  reviews: PrConversationReview[];
  reviewThreads: PrConversationThread[];
  reviewDecision: string | null;
  /** Totals can exceed the returned page sizes. */
  commentsTotal: number;
  reviewsTotal: number;
  reviewThreadsTotal: number;
}

const CONVERSATION_COMMENT_LIMIT = 50;
const CONVERSATION_REVIEW_LIMIT = 30;
const CONVERSATION_THREAD_LIMIT = 50;
const CONVERSATION_THREAD_COMMENT_LIMIT = 50;

const CONVERSATION_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      comments(last: ${CONVERSATION_COMMENT_LIMIT}) {
        totalCount
        nodes { id body createdAt url author { login } }
      }
      reviews(last: ${CONVERSATION_REVIEW_LIMIT}) {
        totalCount
        nodes { id body state submittedAt url author { login } }
      }
      reviewThreads(first: ${CONVERSATION_THREAD_LIMIT}) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: ${CONVERSATION_THREAD_COMMENT_LIMIT}) {
            totalCount
            nodes { id body createdAt url diffHunk author { login } }
          }
        }
      }
    }
  }
}`;

interface RawConversationComment {
  id: string;
  body: string | null;
  createdAt: string | null;
  url: string | null;
  diffHunk?: string | null;
  author: { login: string } | null;
}

function totalOrLength(total: number | undefined, length: number): number {
  return typeof total === "number" && total > length ? total : length;
}

function mapComment(c: RawConversationComment): PrConversationComment {
  return {
    id: c.id,
    author: c.author?.login ? { login: c.author.login } : null,
    body: c.body ?? "",
    createdAt: c.createdAt ?? "",
    url: c.url ?? "",
  };
}

export async function viewPullRequestConversation(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ ok: true; conversation: PrConversation } | { ok: false; error: string }> {
  try {
    const res = await fetchGitHubGraphQL(token, CONVERSATION_QUERY, {
      owner, name: repo, number: pullNumber,
    });
    if (!res.ok) {
      return { ok: false, error: await parseGitHubError(res) };
    }
    const payload = (await res.json()) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewDecision: string | null;
            comments?: { totalCount?: number; nodes: RawConversationComment[] | null } | null;
            reviews?: {
              totalCount?: number;
              nodes:
                | (RawConversationComment & { state: string; submittedAt: string | null })[]
                | null;
            } | null;
            reviewThreads?: {
              totalCount?: number;
              nodes:
                | {
                    id: string;
                    isResolved: boolean;
                    isOutdated: boolean;
                    path: string | null;
                    line: number | null;
                    originalLine: number | null;
                    comments?: { totalCount?: number; nodes: RawConversationComment[] | null } | null;
                  }[]
                | null;
            } | null;
          } | null;
        } | null;
      };
      errors?: { message: string }[];
    };
    if (payload.errors?.length) {
      return { ok: false, error: payload.errors.map((e) => e.message).join("; ") };
    }
    const pr = payload.data?.repository?.pullRequest;
    if (!pr) return { ok: false, error: `Pull request #${pullNumber} not found` };

    const comments = (pr.comments?.nodes ?? []).map(mapComment);
    // Exclude draft reviews from the page and its total; retain unseen reviews.
    const rawReviews = pr.reviews?.nodes ?? [];
    const reviews = rawReviews
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({ ...mapComment(r), state: r.state, submittedAt: r.submittedAt ?? "" }));
    const threads = (pr.reviewThreads?.nodes ?? []).map((t) => {
      const threadComments = (t.comments?.nodes ?? []).map(mapComment);
      return {
        id: t.id,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        path: t.path,
        line: t.line,
        originalLine: t.originalLine ?? null,
        diffHunk: t.comments?.nodes?.[0]?.diffHunk ?? "",
        comments: threadComments,
        commentsTotal: totalOrLength(t.comments?.totalCount, threadComments.length),
      };
    });

    return {
      ok: true,
      conversation: {
        reviewDecision: pr.reviewDecision ?? null,
        comments,
        reviews,
        reviewThreads: threads,
        commentsTotal: totalOrLength(pr.comments?.totalCount, comments.length),
        reviewsTotal: Math.max(
          reviews.length,
          totalOrLength(pr.reviews?.totalCount, rawReviews.length) - (rawReviews.length - reviews.length),
        ),
        reviewThreadsTotal: totalOrLength(pr.reviewThreads?.totalCount, threads.length),
      },
    };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
}

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

export async function disableAutoMerge(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ success: boolean; message: string }> {
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
