/**
 * PrStatusPoller — orchestrator-level PR status poller.
 *
 * One poller per repo, not per session. All sessions sharing a repo share
 * one polling loop. Polls every 3 seconds using a single GitHub GraphQL
 * query per repo (OPEN PRs only). Broadcasts changes via SSE.
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { parseGitHubRemote } from "./git-utils.js";

const POLL_INTERVAL_MS = 3_000;

/** GraphQL query: fetch all open PRs for a repo with CI status. */
const PR_STATUS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN]) {
      nodes {
        number
        title
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
              statusCheckRollup {
                state
                contexts(first: 25) {
                  nodes {
                    ... on CheckRun {
                      name
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
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
interface GraphQLPrNode {
  number: number;
  title: string;
  url: string;
  state: string;
  mergeable: string; // MERGEABLE, CONFLICTING, UNKNOWN
  autoMergeRequest: { mergeMethod: string } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string; // SUCCESS, FAILURE, PENDING, EXPECTED, ERROR
          contexts: {
            nodes: Array<
              | { name: string; status: string; conclusion: string | null }
              | { context: string; state: string }
            >;
          };
        } | null;
      };
    }>;
  };
}

interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes: GraphQLPrNode[];
      };
    };
  };
  errors?: Array<{ message: string }>;
}

/** Parse a GraphQL PR node into a PrStatusSummary. */
export function parsePrNode(
  node: GraphQLPrNode,
  sessionId: string,
): PrStatusSummary {
  const commit = node.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup;

  let passed = 0, failed = 0, pending = 0;
  if (rollup?.contexts?.nodes) {
    for (const ctx of rollup.contexts.nodes) {
      if ("conclusion" in ctx) {
        // CheckRun
        if (ctx.conclusion === "SUCCESS") passed++;
        else if (ctx.conclusion === "FAILURE" || ctx.conclusion === "CANCELLED" || ctx.conclusion === "TIMED_OUT") failed++;
        else if (ctx.status !== "COMPLETED") pending++;
      } else {
        // StatusContext
        if (ctx.state === "SUCCESS") passed++;
        else if (ctx.state === "FAILURE" || ctx.state === "ERROR") failed++;
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

  return {
    sessionId,
    prNumber: node.number,
    prUrl: node.url,
    prTitle: node.title,
    prState: "open",
    baseBranch: node.baseRefName,
    headBranch: node.headRefName,
    insertions: node.additions,
    deletions: node.deletions,
    checks: { state: checksState, total, passed, failed, pending },
    mergeable: node.mergeable === "MERGEABLE",
    autoMergeEnabled: node.autoMergeRequest !== null,
  };
}

export class PrStatusPoller {
  private githubAuth: GitHubAuthManager;
  private sessionManager: SessionManager;
  private sseBroadcast: (event: string, data: unknown) => void;

  /** repoKey (owner/repo) → interval timer */
  private repoTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** sessionId → last known PrStatusSummary (for diffing) */
  private lastKnown = new Map<string, PrStatusSummary>();
  /** sessionId → repo key tracking */
  private sessionRepos = new Map<string, string>();
  /** Sessions whose PRs have been merged — excluded from future queries. */
  private mergedSessions = new Set<string>();

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sessionManager: SessionManager;
    sseBroadcast: (event: string, data: unknown) => void;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sessionManager = opts.sessionManager;
    this.sseBroadcast = opts.sseBroadcast;
  }

  /** Register a session as having an open PR. Starts polling for its repo. */
  trackSession(sessionId: string, repoUrl: string): void {
    const parsed = parseGitHubRemote(repoUrl);
    if (!parsed) return;

    const repoKey = `${parsed.owner}/${parsed.repo}`;
    this.sessionRepos.set(sessionId, repoKey);
    this.mergedSessions.delete(sessionId);

    if (!this.repoTimers.has(repoKey)) {
      this.startPolling(repoKey, parsed.owner, parsed.repo);
    }
  }

  /** Untrack a session (archived, PR merged, etc.). */
  untrackSession(sessionId: string): void {
    const repoKey = this.sessionRepos.get(sessionId);
    this.sessionRepos.delete(sessionId);
    this.lastKnown.delete(sessionId);

    if (repoKey) {
      this.maybeStopPolling(repoKey);
    }
  }

  /** Get the current PR status for a session. */
  getStatus(sessionId: string): PrStatusSummary | undefined {
    return this.lastKnown.get(sessionId);
  }

  /** Get all current PR statuses (for SSE snapshot on connect). */
  getAllStatuses(): PrStatusSummary[] {
    return [...this.lastKnown.values()];
  }

  /** Clean up all timers. */
  destroy(): void {
    for (const timer of this.repoTimers.values()) {
      clearInterval(timer);
    }
    this.repoTimers.clear();
  }

  private startPolling(repoKey: string, owner: string, repo: string): void {
    const timer = setInterval(() => {
      this.pollRepo(repoKey, owner, repo).catch((err) => {
        console.error(`[pr-poller] Error polling ${repoKey}:`, err);
      });
    }, POLL_INTERVAL_MS);

    this.repoTimers.set(repoKey, timer);

    // Run the first poll immediately
    this.pollRepo(repoKey, owner, repo).catch((err) => {
      console.error(`[pr-poller] Error on initial poll ${repoKey}:`, err);
    });
  }

  private maybeStopPolling(repoKey: string): void {
    // Check if any active (non-merged) sessions still use this repo
    const hasActive = [...this.sessionRepos.entries()].some(
      ([sid, key]) => key === repoKey && !this.mergedSessions.has(sid),
    );

    if (!hasActive) {
      const timer = this.repoTimers.get(repoKey);
      if (timer) {
        clearInterval(timer);
        this.repoTimers.delete(repoKey);
      }
    }
  }

  private async pollRepo(repoKey: string, owner: string, repo: string): Promise<void> {
    if (!this.githubAuth.authenticated) return;

    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      PR_STATUS_QUERY,
      { owner, name: repo },
    );

    // graphqlQuery returns the full JSON body, so the data is at the top level
    const prNodes = (result as unknown as GraphQLResponse)?.data?.repository?.pullRequests?.nodes;
    if (!prNodes) return;

    // Build a map of headRefName → PR node for matching
    const prByBranch = new Map<string, GraphQLPrNode>();
    for (const node of prNodes) {
      prByBranch.set(node.headRefName, node);
    }

    // Match PRs to sessions by branch name
    const updates: PrStatusSummary[] = [];
    const sessions = this.sessionManager.list();
    const activeBranches = new Set<string>();

    for (const session of sessions) {
      const sessionRepoKey = this.sessionRepos.get(session.id);
      if (sessionRepoKey !== repoKey) continue;
      if (this.mergedSessions.has(session.id)) continue;
      if (!session.branch) continue;

      activeBranches.add(session.branch);
      const prNode = prByBranch.get(session.branch);

      if (prNode) {
        const summary = parsePrNode(prNode, session.id);
        const prev = this.lastKnown.get(session.id);

        // Only include in broadcast if something changed
        if (!prev || !prStatusEqual(prev, summary)) {
          this.lastKnown.set(session.id, summary);
          updates.push(summary);
        }
      } else {
        // PR disappeared from OPEN results — it may have been merged
        const prev = this.lastKnown.get(session.id);
        if (prev) {
          const mergedSummary: PrStatusSummary = { ...prev, prState: "merged" };
          this.lastKnown.set(session.id, mergedSummary);
          this.mergedSessions.add(session.id);
          updates.push(mergedSummary);
        }
      }
    }

    // Broadcast only if there are changes
    if (updates.length > 0) {
      this.sseBroadcast("pr_status", { updates });
    }
  }
}

/** Shallow comparison of two PrStatusSummary objects. */
function prStatusEqual(a: PrStatusSummary, b: PrStatusSummary): boolean {
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
    a.deletions === b.deletions
  );
}
