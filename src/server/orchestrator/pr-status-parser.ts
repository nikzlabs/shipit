/**
 * Pure GraphQL → domain helpers extracted from PrStatusPoller.
 *
 * No class state, no I/O — these functions translate raw GitHub GraphQL
 * responses into ShipIt domain types, and compare those domain types for
 * equality. Kept side-effect-free so callers (the poller and its tests)
 * can exercise them in isolation.
 */

import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GitHubDeploymentStatus } from "../shared/types/deployment-types.js";

/** GraphQL query: fetch all open PRs for a repo with CI status. */
export const PR_STATUS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN]) {
      nodes {
        number
        title
        body
        url
        state
        mergeable
        autoMergeRequest { mergeMethod }
        headRefName
        baseRefName
        additions
        deletions
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 25) {
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
              deployments(last: 5) {
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

/** Raw GraphQL response shape. */
export interface GraphQLPrNode {
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: string;
  mergeable: string; // MERGEABLE, CONFLICTING, UNKNOWN
  autoMergeRequest: { mergeMethod: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
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
    prState: "open",
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    insertions: node.additions,
    deletions: node.deletions,
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
  };
}

/** Extract the head SHA from a GraphQL PR node. */
export function extractHeadSha(node: GraphQLPrNode): string | undefined {
  return node.commits.nodes[0]?.commit?.oid;
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

/** Shallow comparison of two PrStatusSummary objects. */
export function prStatusEqual(a: PrStatusSummary, b: PrStatusSummary): boolean {
  return (
    a.prState === b.prState &&
    a.checks.state === b.checks.state &&
    a.checks.total === b.checks.total &&
    a.checks.passed === b.checks.passed &&
    a.checks.failed === b.checks.failed &&
    a.checks.pending === b.checks.pending &&
    a.mergeable === b.mergeable &&
    a.autoMergeEnabled === b.autoMergeEnabled &&
    a.insertions === b.insertions &&
    a.deletions === b.deletions &&
    deploymentsEqual(a.deployments, b.deployments)
  );
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
