/**
 * Pure GraphQL → domain helpers extracted from PrStatusPoller.
 *
 * No class state, no I/O — these functions translate raw GitHub GraphQL
 * responses into ShipIt domain types, and compare those domain types for
 * equality. Kept side-effect-free so callers (the poller and its tests)
 * can exercise them in isolation.
 */

import type {
  PrStatusSummary,
  PrIssueComment,
  PrReviewThread,
  PrReviewThreadComment,
} from "../shared/types/github-types.js";
import type { GitHubDeploymentStatus } from "../shared/types/deployment-types.js";

/**
 * Conversation GraphQL selections (docs/133 Phase 4): PR-level issue comments
 * + review threads. Spliced into the PR node only when the poller knows a
 * session's PR tab is the active right-panel tab — these fields roughly double
 * the per-PR payload, so we don't pay for them on every idle poll.
 *
 * `comments(last: 30)` mirrors how GitHub renders the conversation timeline
 * (most recent first matters more than the very first comment). Review-thread
 * comments are bounded at 50 — threads longer than that are vanishingly rare
 * and the panel renders read-only, so truncation is harmless.
 */
const CONVERSATION_SELECTIONS = `
        comments(last: 30) {
          nodes {
            id
            body
            createdAt
            url
            author { login avatarUrl }
          }
        }
        reviewThreads(first: 30) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 50) {
              nodes {
                id
                body
                createdAt
                author { login avatarUrl }
              }
            }
          }
        }`;

/**
 * Build the PR status GraphQL query.
 *
 * The connection sizes (`first: 30` PRs, `first: 10` contexts, `last: 3`
 * deployments) are intentionally bounded to keep the query cost down — at
 * 5s polling, a single actively-watched repo is right at the 5,000 points/hr
 * primary rate-limit budget. If a session's PR is past the `first: 30` cap
 * it gets a per-session REST verify instead (see `verifyMissingPr` in the
 * poller). Status rollups beyond the first 10 contexts are an extreme edge
 * case; if it bites, increase here rather than dropping back to a
 * paginated GraphQL.
 *
 * NOTE: `files(first: 100)` is the hard ceiling — the GitHub GraphQL `files`
 * connection rejects any `first` above 100 with an EXCESSIVE_PAGINATION error
 * (the request 200s but the data is dropped). PRs touching more than 100 files
 * get a truncated file list here; do not raise this above 100.
 *
 * When `includeConversation` is true the per-PR node also selects issue
 * comments + review threads (docs/133 Phase 4). Gated by the poller on whether
 * any tracked session on the repo has its PR tab active.
 */
export function buildPrStatusQuery(includeConversation = false): string {
  return `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 30, states: [OPEN]) {
      nodes {
        number
        title
        body
        createdAt
        author { login avatarUrl }
        url
        state
        mergeable
        autoMergeRequest { mergeMethod }
        headRefName
        baseRefName
        additions
        deletions
        files(first: 100) {
          nodes { path additions deletions changeType }
        }${includeConversation ? CONVERSATION_SELECTIONS : ""}
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 10) {
                  nodes {
                    ... on CheckRun {
                      databaseId
                      name
                      status
                      conclusion
                      title
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
              deployments(last: 3) {
                nodes {
                  environment
                  latestStatus {
                    state
                    environmentUrl
                  }
                  createdAt
                  creator { login }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;
}

/** Light query (no conversation fields) — the default for idle polling. */
export const PR_STATUS_QUERY = buildPrStatusQuery(false);

/** Heavy query including conversation fields — used when a PR tab is active. */
export const PR_STATUS_QUERY_WITH_CONVERSATION = buildPrStatusQuery(true);

/** Raw GraphQL response shape. */
export interface GraphQLPrNode {
  number: number;
  title: string;
  body: string | null;
  createdAt?: string;
  author?: { login: string; avatarUrl: string | null } | null;
  url: string;
  state: string;
  mergeable: string; // MERGEABLE, CONFLICTING, UNKNOWN
  autoMergeRequest: { mergeMethod: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  files?: { nodes: { path: string; additions?: number; deletions?: number; changeType?: string }[] } | null;
  comments?: {
    nodes: {
      id: string;
      body: string;
      createdAt: string;
      url: string;
      author: { login: string; avatarUrl: string | null } | null;
    }[];
  } | null;
  reviewThreads?: {
    nodes: {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      comments: {
        nodes: {
          id: string;
          body: string;
          createdAt: string;
          author: { login: string; avatarUrl: string | null } | null;
        }[];
      };
    }[];
  } | null;
  commits: {
    nodes: {
      commit: {
        oid?: string;
        statusCheckRollup: {
          state: string; // SUCCESS, FAILURE, PENDING, EXPECTED, ERROR
          contexts: {
            nodes: (| { databaseId?: number; name: string; status: string; conclusion: string | null; title?: string | null; detailsUrl?: string | null }
              | { context: string; state: string })[];
          };
        } | null;
        deployments?: {
          nodes: {
            environment: string;
            latestStatus: { state: string; environmentUrl: string | null } | null;
            createdAt: string;
            creator: { login: string } | null;
          }[];
        } | null;
      };
    }[];
  };
}

export interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes: GraphQLPrNode[];
      };
    };
  };
  errors?: { message: string }[];
}

/** Map GitHub GraphQL deployment state string to our typed state. */
export function mapDeploymentState(state: string | undefined): GitHubDeploymentStatus["state"] {
  switch (state?.toUpperCase()) {
    case "SUCCESS": case "ACTIVE": return "success";
    case "FAILURE": return "failure";
    case "ERROR": return "error";
    case "INACTIVE": case "DESTROYED": case "ABANDONED": return "inactive";
    case "IN_PROGRESS": return "in_progress";
    case "QUEUED": case "WAITING": return "queued";
    case "PENDING": default: return "pending";
  }
}

/**
 * Parse the conversation selections (issue comments + review threads) off a
 * GraphQL PR node. Returns `undefined` for a field that wasn't selected (the
 * light query omits them), distinguishing "not fetched" from "fetched, empty".
 */
export function parseConversation(node: GraphQLPrNode): {
  issueComments?: PrIssueComment[];
  reviewThreads?: PrReviewThread[];
} {
  let issueComments: PrIssueComment[] | undefined;
  if (node.comments?.nodes) {
    issueComments = node.comments.nodes.map((c) => ({
      id: c.id,
      author: { login: c.author?.login ?? "ghost", avatarUrl: c.author?.avatarUrl ?? "" },
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
    }));
  }

  let reviewThreads: PrReviewThread[] | undefined;
  if (node.reviewThreads?.nodes) {
    reviewThreads = node.reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      comments: (t.comments?.nodes ?? []).map((c): PrReviewThreadComment => ({
        id: c.id,
        author: { login: c.author?.login ?? "ghost", avatarUrl: c.author?.avatarUrl ?? "" },
        body: c.body,
        createdAt: c.createdAt,
      })),
    }));
  }

  return { issueComments, reviewThreads };
}

/** Parse a GraphQL PR node into a PrStatusSummary. */
export function parsePrNode(
  node: GraphQLPrNode,
  sessionId: string,
): PrStatusSummary {
  const commit = node.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup;

  let passed = 0, failed = 0, pending = 0;
  const failedChecks: { name: string; summary: string }[] = [];

  if (rollup?.contexts?.nodes) {
    for (const ctx of rollup.contexts.nodes) {
      if ("conclusion" in ctx && "name" in ctx && !("context" in ctx)) {
        // CheckRun
        if (ctx.conclusion === "SUCCESS") passed++;
        else if (ctx.conclusion === "FAILURE" || ctx.conclusion === "CANCELLED" || ctx.conclusion === "TIMED_OUT") {
          failed++;
          failedChecks.push({
            name: ctx.name,
            summary: (ctx as { title?: string | null }).title ?? ctx.conclusion ?? "failed",
          });
        }
        else if (ctx.status !== "COMPLETED") pending++;
      } else if ("context" in ctx) {
        // StatusContext
        const sc = ctx as { context: string; state: string };
        if (sc.state === "SUCCESS") passed++;
        else if (sc.state === "FAILURE" || sc.state === "ERROR") {
          failed++;
          failedChecks.push({ name: sc.context, summary: sc.state.toLowerCase() });
        }
        else pending++;
      }
    }
  }

  const total = passed + failed + pending;
  const checksState: PrStatusSummary["checks"]["state"] =
    total === 0 ? "none" :
    failed > 0 ? "failure" :
    pending > 0 ? "pending" :
    "success";

  // Parse deployments from commit
  const deploymentNodes = commit?.deployments?.nodes;
  let deployments: GitHubDeploymentStatus[] | undefined;
  if (deploymentNodes && deploymentNodes.length > 0) {
    deployments = deploymentNodes.map((d) => ({
      environment: d.environment,
      state: mapDeploymentState(d.latestStatus?.state),
      environmentUrl: d.latestStatus?.environmentUrl ?? null,
      createdAt: d.createdAt,
      creator: d.creator?.login ?? null,
    }));
  }

  return {
    sessionId,
    prNumber: node.number,
    prUrl: node.url,
    prTitle: node.title,
    prBody: node.body ?? "",
    prCreatedAt: node.createdAt,
    prAuthor: node.author ? { login: node.author.login, avatarUrl: node.author.avatarUrl ?? "" } : undefined,
    prState: "open",
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    insertions: node.additions,
    deletions: node.deletions,
    files: parseFiles(node),
    checks: {
      state: checksState,
      total,
      passed,
      failed,
      pending,
      failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
    },
    mergeable:
      node.mergeable === "MERGEABLE" ? "mergeable" :
      node.mergeable === "CONFLICTING" ? "conflicting" :
      "unknown",
    autoMergeEnabled: node.autoMergeRequest !== null,
    deployments,
    ...parseConversation(node),
  };
}

/** Extract the head SHA from a GraphQL PR node. */
export function extractHeadSha(node: GraphQLPrNode): string | undefined {
  return node.commits.nodes[0]?.commit?.oid;
}

/**
 * Extract the list of changed file paths from a GraphQL PR node.
 *
 * Capped at 300 by the query — see `PR_STATUS_QUERY`. PRs that touch more
 * than 300 files return a truncated list; callers should treat the result
 * as "best-effort" rather than authoritative for full-PR diff analysis.
 * For workflow-applies decisions, truncation is safe: a 300+ file PR is
 * exceedingly unlikely to be entirely `paths:`-filtered-out.
 */
export function extractChangedFiles(node: GraphQLPrNode): string[] {
  const nodes = node.files?.nodes;
  if (!nodes) return [];
  return nodes.map((f) => f.path).filter((p): p is string => typeof p === "string" && p.length > 0);
}

function parseFiles(node: GraphQLPrNode): PrStatusSummary["files"] {
  const nodes = node.files?.nodes;
  if (!nodes) return undefined;
  return nodes
    .filter((f) => typeof f.path === "string" && f.path.length > 0)
    .map((f) => ({
      path: f.path,
      status: mapFileChangeType(f.changeType),
      insertions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));
}

function mapFileChangeType(changeType: string | undefined): string {
  switch (changeType) {
    case "ADDED": return "A";
    case "DELETED": return "D";
    case "RENAMED": return "R";
    case "COPIED": return "C";
    case "CHANGED":
    default: return "M";
  }
}

/** Extract failed check run database IDs from a GraphQL PR node. */
export function extractFailedCheckRuns(node: GraphQLPrNode): {
  databaseId: number;
  name: string;
  conclusion: string;
  title: string;
}[] {
  const commit = node.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  if (!rollup?.contexts?.nodes) return [];

  const failed: { databaseId: number; name: string; conclusion: string; title: string }[] = [];
  for (const ctx of rollup.contexts.nodes) {
    if ("conclusion" in ctx && "name" in ctx && !("context" in ctx)) {
      const checkCtx = ctx as { databaseId?: number; name: string; status: string; conclusion: string | null; title?: string | null };
      if (
        checkCtx.databaseId &&
        (checkCtx.conclusion === "FAILURE" || checkCtx.conclusion === "CANCELLED" || checkCtx.conclusion === "TIMED_OUT")
      ) {
        failed.push({
          databaseId: checkCtx.databaseId,
          name: checkCtx.name,
          conclusion: checkCtx.conclusion,
          title: checkCtx.title ?? checkCtx.conclusion,
        });
      }
    }
  }
  return failed;
}

/**
 * Shallow comparison of two PrStatusSummary objects.
 *
 * Title and body are included because the PR card renders them inline — when
 * the user (or the agent, or a teammate on github.com) edits the PR
 * description, the poller picks up the new value and we need to broadcast it
 * so the card refreshes without a reload. Without these checks, the
 * change-detection gate would swallow the update and the card would keep
 * showing the stale title/description until the next CI/state event.
 */
export function prStatusEqual(a: PrStatusSummary, b: PrStatusSummary): boolean {
  return (
    a.prState === b.prState &&
    a.prTitle === b.prTitle &&
    a.prBody === b.prBody &&
    a.prCreatedAt === b.prCreatedAt &&
    a.prAuthor?.login === b.prAuthor?.login &&
    a.prAuthor?.avatarUrl === b.prAuthor?.avatarUrl &&
    a.checks.state === b.checks.state &&
    a.checks.total === b.checks.total &&
    a.checks.passed === b.checks.passed &&
    a.checks.failed === b.checks.failed &&
    a.checks.pending === b.checks.pending &&
    a.mergeable === b.mergeable &&
    a.autoMergeEnabled === b.autoMergeEnabled &&
    a.insertions === b.insertions &&
    a.deletions === b.deletions &&
    filesEqual(a.files, b.files) &&
    deploymentsEqual(a.deployments, b.deployments) &&
    conversationEqual(a, b)
  );
}

function filesEqual(a?: PrStatusSummary["files"], b?: PrStatusSummary["files"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((f, i) =>
    f.path === b[i].path &&
    f.status === b[i].status &&
    f.insertions === b[i].insertions &&
    f.deletions === b[i].deletions,
  );
}

/**
 * Compare the conversation (issue comments + review threads) of two summaries.
 *
 * `undefined` means "not fetched this poll" (light query). The poller carries
 * the previous conversation forward onto a light-poll summary before calling
 * this, so in practice both sides are either both-undefined (never fetched) or
 * both-defined. We still treat a defined/undefined mismatch as "changed" so
 * the very first heavy poll — when comments first arrive — broadcasts.
 */
export function conversationEqual(a: PrStatusSummary, b: PrStatusSummary): boolean {
  return (
    issueCommentsEqual(a.issueComments, b.issueComments) &&
    reviewThreadsEqual(a.reviewThreads, b.reviewThreads)
  );
}

function issueCommentsEqual(a?: PrIssueComment[], b?: PrIssueComment[]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.id === b[i].id && c.body === b[i].body);
}

function reviewThreadsEqual(a?: PrReviewThread[], b?: PrReviewThread[]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((t, i) => {
    const o = b[i];
    return (
      t.id === o.id &&
      t.isResolved === o.isResolved &&
      t.isOutdated === o.isOutdated &&
      t.comments.length === o.comments.length &&
      t.comments.every((c, j) => c.id === o.comments[j].id && c.body === o.comments[j].body)
    );
  });
}

/** Compare deployment arrays for equality. */
export function deploymentsEqual(
  a: GitHubDeploymentStatus[] | undefined,
  b: GitHubDeploymentStatus[] | undefined,
): boolean {
  if (!a && !b) return true;
  if (a?.length !== b?.length) return false;
  return a!.every((d, i) =>
    d.state === b![i].state &&
    d.environment === b![i].environment &&
    d.environmentUrl === b![i].environmentUrl &&
    d.creator === b![i].creator &&
    d.createdAt === b![i].createdAt,
  );
}
