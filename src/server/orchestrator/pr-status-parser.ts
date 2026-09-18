import type {
  PrStatusSummary,
  PrReviewDecision,
  PrIssueComment,
  PrReviewThread,
  PrReviewThreadComment,
} from "../shared/types/github-types.js";
import type { GitHubDeploymentStatus } from "../shared/types/deployment-types.js";

// GitHub rejects files(first: N) above 100; larger PRs have truncated file lists.
const PR_LIGHT_FIELDS = `
        number
        title
        body
        createdAt
        author { login avatarUrl }
        url
        state
        mergeable
        reviewDecision
        autoMergeRequest { mergeMethod }
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        additions
        deletions
        files(first: 100) {
          nodes { path additions deletions changeType }
        }
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
        }`;

const CONVERSATION_FIELDS = `
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

/** Coverage aliases retain tracked PRs outside the bulk window.
 * Fetch conversation only for focused PRs to limit query cost.
 */
export function buildPrStatusQuery(opts: {
  first: number;
  focusedPrNumbers?: readonly number[];
  coveragePrNumbers?: readonly number[];
}): string {
  const { first, focusedPrNumbers = [], coveragePrNumbers = [] } = opts;
  const focusedSet = new Set(focusedPrNumbers);
  const focusedAliases = focusedPrNumbers
    .map((n, i) => `
    focused${i}: pullRequest(number: ${n}) {
      ${PR_LIGHT_FIELDS}
      ${CONVERSATION_FIELDS}
    }`)
    .join("");
  const coverageAliases = coveragePrNumbers
    .filter((n) => !focusedSet.has(n))
    .map((n, i) => `
    coverage${i}: pullRequest(number: ${n}) {
      ${PR_LIGHT_FIELDS}
    }`)
    .join("");
  return `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: ${first}, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        ${PR_LIGHT_FIELDS}
      }
    }${focusedAliases}${coverageAliases}
  }
}
`;
}

export interface GraphQLPrNode {
  number: number;
  title: string;
  body: string | null;
  createdAt?: string;
  author?: { login: string; avatarUrl: string | null } | null;
  url: string;
  state: string;
  mergeable: string;
  reviewDecision: string | null;
  autoMergeRequest: { mergeMethod: string } | null;
  headRefName: string;
  /** Ref tip; commits(last: 1) and its CI rollup can lag after a push. */
  headRefOid?: string;
  baseRefName: string;
  baseRefOid?: string;
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
          state: string;
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
      /** Canonical owner/repo after GitHub transfer or rename redirects. */
      nameWithOwner?: string;
      pullRequests?: {
        nodes: GraphQLPrNode[];
      };
    };
  };
  errors?: { message: string }[];
}

export function extractFocusedPrNodes(result: unknown): Map<number, GraphQLPrNode> {
  const out = new Map<number, GraphQLPrNode>();
  const repository = (result as { data?: { repository?: Record<string, unknown> } })?.data?.repository;
  if (!repository) return out;
  for (const [key, value] of Object.entries(repository)) {
    if (!key.startsWith("focused") && !key.startsWith("coverage")) continue;
    if (!value || typeof value !== "object") continue;
    const candidate = value as { number?: unknown };
    if (typeof candidate.number !== "number") continue;
    out.set(candidate.number, value as GraphQLPrNode);
  }
  return out;
}

export function mapReviewDecision(decision: string | null | undefined): PrReviewDecision {
  switch (decision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes_requested";
    case "REVIEW_REQUIRED": return "review_required";
    default: return "none";
  }
}

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

/** undefined means not fetched; an empty array means fetched with no entries. */
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
    reviewDecision: mapReviewDecision(node.reviewDecision),
    autoMergeEnabled: node.autoMergeRequest !== null,
    deployments,
    ...parseConversation(node),
  };
}

/** CI rollup commit, which can lag behind extractCurrentHeadOid after a push. */
export function extractHeadSha(node: GraphQLPrNode): string | undefined {
  return node.commits.nodes[0]?.commit?.oid;
}

export function extractCurrentHeadOid(node: GraphQLPrNode): string | undefined {
  return node.headRefOid;
}

export function extractBaseSha(node: GraphQLPrNode): string | undefined {
  return node.baseRefOid;
}

/** At most 100 paths from this query; not a complete diff for larger PRs. */
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
    a.checks.graceUntil === b.checks.graceUntil &&
    a.mergeable === b.mergeable &&
    a.reviewDecision === b.reviewDecision &&
    a.branchSync?.state === b.branchSync?.state &&
    a.branchSync?.ahead === b.branchSync?.ahead &&
    a.branchSync?.behind === b.branchSync?.behind &&
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
