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
    merge_commit_sha: pr.merge_commit_sha ?? null,
    // docs/218 — the branch tip the PR shipped from. Recorded as the session's
    // `mergedHeadSha` safety anchor so a later auto-reset on continue only fires
    // when the local branch still sits exactly at this commit (no post-merge
    // work to clobber). The list endpoint includes `head.sha`; fail closed to
    // null if a malformed/partial response omits it.
    head_sha: pr.head?.sha ?? null,
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
 *
 * docs/287-agent-merge-per-repo req 16 — `expectedSha` is GitHub's own
 * optimistic-concurrency check: it merges only while the head is still that
 * commit, and answers 409 otherwise. Any caller that decided to merge by
 * looking at a commit must pass the commit it looked at, or everything between
 * the check and this call merges unchecked. Omitted by callers with nothing to
 * pin (the UI card merges what the card shows).
 */
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
  const body: Record<string, string> = { merge_method: method };
  if (typeof commitTitle === "string") body.commit_title = commitTitle;
  if (typeof commitMessage === "string") body.commit_message = commitMessage;
  if (expectedSha) body.sha = expectedSha;

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
    // 409 with an `expectedSha` is specifically "the head moved between the
    // check and this call" — the case the parameter exists to catch, and worth
    // naming, because GitHub's own wording ("Head branch was modified") does not
    // tell the caller what to do next.
    if (res.status === 409 && expectedSha) {
      return {
        success: false,
        message:
          `${err.message || "Head branch was modified"} — the branch moved after its checks were `
          + "read, so nothing was merged. Merge again once the new head's checks report.",
      };
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
    const lower = errMsg.toLowerCase();
    // Map GitHub's GraphQL errors to actionable guidance. These strings are
    // surfaced verbatim in the managed-merge tooltip (docs/077), so a cryptic
    // raw error like "Pull request is in clean status" is rewritten to name the
    // precondition the user actually needs to fix.
    if (lower.includes("auto-merge") || lower.includes("not allowed")) {
      // Repo-level "Allow auto-merge" checkbox is off (Settings → General →
      // Pull Requests). This is the most common cause even when branch
      // protection / rulesets are already configured.
      return { success: false, message: "“Allow auto-merge” is turned off for this repository. Enable it in Settings → General → Pull Requests." };
    }
    if (lower.includes("clean status") || lower.includes("not in")) {
      // Nothing is gating the PR (no required status check / approval), so
      // GitHub considers it immediately mergeable and refuses auto-merge.
      return { success: false, message: "No branch protection rule requires a status check or review on the base branch, so there's nothing for auto-merge to wait on. Add a required check to the rule (or ruleset)." };
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
 * Add one or more labels to a pull request. PRs are issues on GitHub, so this
 * uses the issues `labels` endpoint. The operation is **additive** — GitHub
 * merges these with any existing labels rather than replacing them.
 *
 * Best-effort by contract: callers treat a failure (a label name that doesn't
 * exist on the repo → 422, a token without Issues:write → 403, etc.) as a
 * non-fatal warning, never an error that blocks opening/editing the PR. We
 * never throw — failures come back as `{ success: false, message }`.
 */
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

/**
 * Remove a single label from a pull request. PRs are issues on GitHub, so this
 * uses the issues `labels/{name}` endpoint (`DELETE`).
 *
 * Best-effort by contract, mirroring {@link addLabelsToPullRequest}: a label
 * that isn't on the PR (or doesn't exist on the repo) comes back from GitHub as
 * a 404, which for *removal* is already the desired end state — so we treat it
 * as success (idempotent). Other failures (e.g. a token without Issues:write →
 * 403) return `{ success: false, message }` so the caller can degrade to a
 * non-fatal warning rather than blocking the edit. We never throw.
 */
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
    // 404 → the label isn't applied to this PR (or doesn't exist). Removal is
    // idempotent, so the desired state is already met: report success.
    if (res.status === 404) return { success: true };
    if (!res.ok) {
      return { success: false, message: await parseGitHubError(res) };
    }
    return { success: true };
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

/** The pull-request states `listPullRequests` accepts (real `gh`'s set). */
export type PrListState = "open" | "closed" | "merged" | "all";

/** Same set as a value, for validating a query parameter. */
export const PR_LIST_STATES: readonly PrListState[] = ["open", "closed", "merged", "all"];

/** A single row of `listPullRequests`. `mergedAt` is null unless the PR merged. */
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

/**
 * The outcome of a list read: the rows, or why they could not be read.
 *
 * A bare array cannot express the difference. `if (!res.ok) return []` made a
 * 403 on a private repository, a rate-limit response and a GitHub 5xx all
 * render as `gh pr list`'s "No pull requests found." — an unreadable repository
 * and an empty one were the same answer. That is the failure-looks-like-absence
 * confusion `viewPullRequestResult` removes one read over, and it is why
 * `ok: true` with an empty `prs` is now the ONLY way to say "none".
 */
export type ListPullRequestsResult =
  | { ok: true; prs: ListedPullRequest[] }
  | { ok: false; error: string };

/** How many rows `listPullRequests` returns by default, matching real `gh`. */
const PR_LIST_PAGE = 30;

/** Upper bound on `-L/--limit`, the largest page either API will serve. */
const PR_LIST_MAX = 100;

/** Clamp a caller-supplied limit; absent means the default page. */
function pageSize(limit: number | undefined): number {
  if (limit === undefined) return PR_LIST_PAGE;
  return Math.min(Math.max(Math.trunc(limit), 1), PR_LIST_MAX);
}

/**
 * `merged` asked over GraphQL, which has the state natively.
 *
 * REST does not: there, a merged PR is a closed one carrying a `merged_at`, so
 * REST could only answer by fetching closed PRs and filtering — and a filter
 * over one page is not a bound. A repository whose most recently updated closed
 * PRs happen to be unmerged would answer "no merged pull requests", reproducing
 * through a second mechanism exactly the wrong-but-plausible answer this state
 * exists to remove. GraphQL does the selection server-side, so 30 merged rows
 * are 30 merged rows however old they are.
 */
const MERGED_PRS_QUERY = `query($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: MERGED, first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { url number title isDraft mergedAt baseRefName headRefName }
    }
  }
}`;

/**
 * List a repository's pull requests in the given state.
 * Returns a small array of PR metadata sorted by most recently updated.
 *
 * The three REST states go to REST; `merged` goes to GraphQL (see
 * `MERGED_PRS_QUERY`). Both shapes normalise to the same row: GitHub models a
 * merged PR as closed, so `state` stays `"closed"` and `mergedAt` is what
 * distinguishes it.
 *
 * A failed read reports the failure (see `ListPullRequestsResult`) rather than
 * an empty list — no status is "there are none" here, unlike the 404 that
 * genuinely means it for a single-PR read.
 *
 * `limit` is `-L/--limit`. It reaches the API as the page size rather than
 * trimming the response, so asking for more than the default actually fetches
 * more; the shim rejects an out-of-range value before it gets here, and the
 * clamp is the belt to that braces.
 */
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
  // GraphQL answers 200 with an `errors` array, so this is the shape a
  // permission failure takes here — reporting it as an empty list is exactly
  // the confusion the result type exists to remove.
  if (data.errors) return { ok: false, error: data.errors[0]?.message ?? "Unknown GraphQL error" };
  // A 200 whose body does not carry the node list did not answer the question,
  // and "did not answer" is not "there are none" — defaulting the missing path
  // to `[]` would smuggle the original bug back in through the last gap.
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
      // GitHub models a merged PR as closed; `mergedAt` is the distinguishing
      // field, and REST would report exactly this pair for the same PR.
      state: "closed" as const,
      isDraft: pr.isDraft,
      mergedAt: pr.mergedAt,
    })),
  };
}

/**
 * A pull request's details as `gh pr view` exposes them.
 *
 * `base`/`head` are ShipIt's original names and stay; `baseRefName`/
 * `headRefName` are the real-`gh` spellings, carried as aliases so an agent's
 * existing habits transfer (docs/255-pr-comment-reads req 7). The `author`/`labels`/timestamp
 * fields exist for the same reason: `--json` field names are now validated
 * strictly, so the error should fire on genuinely unsupported names rather than
 * on ordinary ones.
 */
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

/**
 * Fetch a single pull request's details.
 */
export async function viewPullRequest(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDetail | null> {
  const result = await viewPullRequestResult(token, owner, repo, pullNumber);
  return result.ok ? result.pr : null;
}

/**
 * Same read as `viewPullRequest`, but distinguishing "GitHub says this PR does
 * not exist" from "the request failed".
 *
 * `viewPullRequest` collapses both to `null`, so `gh pr view` reported a 403 on
 * a private repo — or a GitHub 5xx — as "No pull request found for this
 * branch". That is the same failure-looks-like-absence confusion docs/255
 * exists to remove, one layer down. The collapsing wrapper is kept because its
 * other callers (the merge path's title/body lookup, the release poller) treat
 * a failed read as "no extra info" and must not start throwing.
 */
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
  // 404 is the only status that genuinely means "no such PR". Anything else —
  // 401/403 (no access), 5xx, rate limiting — is a failure to read, and the
  // caller must be able to say so.
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

// ---------------------------------------------------------------------------
// PR conversation reads (docs/255)
//
// The agent could write PR comments (`gh pr comment`) but had no supported way
// to READ them — `gh pr view --json comments` returned `{}`, indistinguishable
// from a PR with no discussion, so review findings were invisible to the agent
// that had to act on them. One GraphQL query covers all three concepts GitHub
// splits review feedback across.
// ---------------------------------------------------------------------------

/** One issue-style conversation comment on a PR. */
export interface PrConversationComment {
  id: string;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string;
}

/** A review-level submission: its summary body and verdict. */
export interface PrConversationReview {
  id: string;
  author: { login: string } | null;
  body: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  submittedAt: string;
  url: string;
}

/** An inline code-review thread anchored to a file and line. */
export interface PrConversationThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  /** The thread's line in the CURRENT diff — null once the thread is outdated. */
  line: number | null;
  /**
   * The line the thread was originally left on. GitHub keeps this after the
   * code moves, so it is the only location an outdated thread has — and
   * outdated threads are exactly the common case for a review you're reading
   * after pushing a fix.
   */
  originalLine: number | null;
  /** The diff context the thread was left on (from its first comment). */
  diffHunk: string;
  comments: PrConversationComment[];
  /** Total comments on the thread; `comments.length` may be a window of it. */
  commentsTotal: number;
}

export interface PrConversation {
  comments: PrConversationComment[];
  reviews: PrConversationReview[];
  reviewThreads: PrConversationThread[];
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (no review required). */
  reviewDecision: string | null;
  /**
   * How many GitHub actually holds, which is NOT `array.length`: the query is
   * bounded (see the limits below), so a very busy PR comes back windowed.
   * Without these the shim would print the window size as the total and tell
   * the agent it had read everything — the same "looks complete, isn't"
   * failure this feature exists to remove.
   */
  commentsTotal: number;
  reviewsTotal: number;
  reviewThreadsTotal: number;
}

/**
 * Bounds on the conversation query, mirroring the PR-status poller's caps
 * (`pr-status-parser.ts`): recent-first for the timeline, generous but finite
 * for threads. A conversation past these bounds is vanishingly rare, and the
 * caps keep one `gh pr view --comments` from pulling an unbounded payload —
 * the `*Total` fields above report what was left outside the window.
 */
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

/**
 * GitHub's `totalCount` for a connection, floored at how many we actually
 * received — a total below the list we return would be nonsense, and a missing
 * one means "assume we have them all".
 */
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

/**
 * Fetch a PR's conversation: issue comments, review submissions, and inline
 * review threads.
 *
 * Returns a discriminated result rather than `null` so a *failed* read can
 * never be rendered as "no comments" — the caller surfaces the error instead
 * (docs/255-pr-comment-reads req 5). A review still in `PENDING` state (an unsubmitted draft
 * review, visible only to its author) is dropped: it isn't feedback yet.
 */
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
    // PENDING reviews are filtered out but still counted by `totalCount`, so
    // derive the review total from what we kept plus whatever fell outside the
    // window — never a number smaller than the list we return.
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
