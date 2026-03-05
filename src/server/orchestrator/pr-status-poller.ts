/**
 * PrStatusPoller — orchestrator-level PR status poller.
 *
 * One poller per repo, not per session. All sessions sharing a repo share
 * one polling loop. Polls every 3 seconds using a single GitHub GraphQL
 * query per repo (OPEN PRs only). Broadcasts changes via SSE.
 *
 * Phase 2 additions: auto-fix state management, per-check failure details,
 * server-driven auto-fix loop.
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { PrStatusSummary, AutoFixState, AutoMergeState, PrAutoMergeError } from "../shared/types/github-types.js";
import { parseGitHubRemote } from "./git-utils.js";

const POLL_INTERVAL_MS = 3_000;
const MAX_AUTO_FIX_ATTEMPTS = 3;

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
      };
    }[];
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
  errors?: { message: string }[];
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
    checks: {
      state: checksState,
      total,
      passed,
      failed,
      pending,
      failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
    },
    mergeable: node.mergeable === "MERGEABLE",
    autoMergeEnabled: node.autoMergeRequest !== null,
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
  /** Sessions whose PRs have been merged or closed — excluded from future queries. */
  private mergedSessions = new Set<string>();
  /** Sessions needing a one-time REST probe to check if a PR already exists (post-restart catch-up). */
  private pendingCatchUp = new Set<string>();

  /** sessionId → auto-fix state */
  private autoFixStates = new Map<string, AutoFixState>();
  /** sessionId → auto-merge state */
  private autoMergeStates = new Map<string, AutoMergeState>();

  /** Optional: runner registry for server-initiated fix prompts. */
  private runnerRegistry?: SessionRunnerRegistry;
  /** Optional: function to fetch CI failure logs and construct a fix prompt. */
  private fetchAndFixCb?: (sessionId: string, owner: string, repo: string, failedChecks: { databaseId: number; name: string; conclusion: string; title: string }[]) => Promise<void>;
  /** Optional: called when a merged PR is detected — used to archive the session. */
  private onMergeDetectedCb?: (sessionId: string) => Promise<void>;

  /** sessionId → last known GraphQL PR node (cached for extracting check details). */
  private lastPrNodes = new Map<string, GraphQLPrNode>();

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sessionManager: SessionManager;
    sseBroadcast: (event: string, data: unknown) => void;
    runnerRegistry?: SessionRunnerRegistry;
    fetchAndFixCb?: (sessionId: string, owner: string, repo: string, failedChecks: { databaseId: number; name: string; conclusion: string; title: string }[]) => Promise<void>;
    onMergeDetectedCb?: (sessionId: string) => Promise<void>;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sessionManager = opts.sessionManager;
    this.sseBroadcast = opts.sseBroadcast;
    this.runnerRegistry = opts.runnerRegistry;
    this.fetchAndFixCb = opts.fetchAndFixCb;
    this.onMergeDetectedCb = opts.onMergeDetectedCb;
  }

  /** Register a session as having an open PR. Starts polling for its repo. */
  trackSession(sessionId: string, repoUrl: string): void {
    const parsed = parseGitHubRemote(repoUrl);
    if (!parsed) return;

    const repoKey = `${parsed.owner}/${parsed.repo}`;
    this.sessionRepos.set(sessionId, repoKey);
    this.mergedSessions.delete(sessionId);
    this.pendingCatchUp.add(sessionId);

    if (!this.repoTimers.has(repoKey)) {
      this.startPolling(repoKey, parsed.owner, parsed.repo);
    }
  }

  /** Untrack a session (archived, PR merged, etc.). */
  untrackSession(sessionId: string): void {
    const repoKey = this.sessionRepos.get(sessionId);
    this.sessionRepos.delete(sessionId);
    this.lastKnown.delete(sessionId);
    this.autoFixStates.delete(sessionId);
    this.autoMergeStates.delete(sessionId);
    this.lastPrNodes.delete(sessionId);
    this.pendingCatchUp.delete(sessionId);

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
    return [...this.lastKnown.values()].map((s) => this.attachAutomationState(s));
  }

  /** Get auto-fix state for a session. */
  getAutoFixState(sessionId: string): AutoFixState | undefined {
    return this.autoFixStates.get(sessionId);
  }

  /** Set auto-fix enabled/disabled for a session. Returns the updated state. */
  setAutoFixEnabled(sessionId: string, enabled: boolean): AutoFixState {
    let state = this.autoFixStates.get(sessionId);
    if (!state) {
      state = { enabled, attemptCount: 0, lastHeadSha: "", status: "idle" };
      this.autoFixStates.set(sessionId, state);
    } else {
      state.enabled = enabled;
      if (!enabled && state.status === "running") {
        state.status = "idle";
      }
    }

    this.broadcastSessionStatus(sessionId);
    return state;
  }

  /** Get the cached GraphQL PR node for a session (for extracting check details). */
  getLastPrNode(sessionId: string): GraphQLPrNode | undefined {
    return this.lastPrNodes.get(sessionId);
  }

  /** Increment attempt count for auto-fix and set status to running. */
  markAutoFixRunning(sessionId: string): void {
    const state = this.autoFixStates.get(sessionId);
    if (!state) return;
    state.attemptCount++;
    state.status = "running";

    this.broadcastSessionStatus(sessionId);
  }

  // ---- Auto-merge state management ----

  /** Get auto-merge state for a session. */
  getAutoMergeState(sessionId: string): AutoMergeState | undefined {
    return this.autoMergeStates.get(sessionId);
  }

  /** Set auto-merge enabled/disabled for a session. */
  setAutoMergeEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    let state = this.autoMergeStates.get(sessionId);
    if (!state) {
      state = { enabled, mergeMethod: "squash" };
      this.autoMergeStates.set(sessionId, state);
    } else {
      state.enabled = enabled;
      if (enabled) {
        // Clear any previous error when re-enabling
        delete state.error;
      }
    }

    this.broadcastSessionStatus(sessionId);
    return state;
  }

  /** Set an auto-merge error (toggle reverts to OFF). */
  setAutoMergeError(sessionId: string, error: PrAutoMergeError): void {
    let state = this.autoMergeStates.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: "squash", error };
      this.autoMergeStates.set(sessionId, state);
    } else {
      state.error = error;
    }

    this.broadcastSessionStatus(sessionId);
  }

  /** Set the preferred merge method for a session. */
  setMergeMethod(sessionId: string, method: "squash" | "merge" | "rebase"): void {
    let state = this.autoMergeStates.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: method };
      this.autoMergeStates.set(sessionId, state);
    } else {
      state.mergeMethod = method;
    }

    this.broadcastSessionStatus(sessionId);
  }

  /** Clean up all timers. */
  destroy(): void {
    for (const timer of this.repoTimers.values()) {
      clearInterval(timer);
    }
    this.repoTimers.clear();
  }

  /** Broadcast current status for a single session. */
  private broadcastSessionStatus(sessionId: string): void {
    const status = this.lastKnown.get(sessionId);
    if (status) {
      const updated = this.attachAutomationState(status);
      this.sseBroadcast("pr_status", { updates: [updated] });
    }
  }

  /** Attach auto-fix and auto-merge state to a PrStatusSummary for SSE broadcast. */
  private attachAutomationState(summary: PrStatusSummary): PrStatusSummary {
    let result = summary;
    const fixState = this.autoFixStates.get(summary.sessionId);
    if (fixState) {
      result = {
        ...result,
        autoFix: {
          enabled: fixState.enabled,
          status: fixState.status,
          attemptCount: fixState.attemptCount,
          maxAttempts: MAX_AUTO_FIX_ATTEMPTS,
        },
      };
    }
    const mergeState = this.autoMergeStates.get(summary.sessionId);
    if (mergeState) {
      result = {
        ...result,
        autoMerge: {
          enabled: mergeState.enabled,
          mergeMethod: mergeState.mergeMethod,
          error: mergeState.error,
        },
      };
    }
    return result;
  }

  private startPolling(repoKey: string, owner: string, repo: string): void {
    const timer = setInterval(() => {
      this.pollRepo(repoKey, owner, repo).catch((err: unknown) => {
        console.error(`[pr-poller] Error polling ${repoKey}:`, err);
      });
    }, POLL_INTERVAL_MS);

    this.repoTimers.set(repoKey, timer);

    // Run the first poll immediately
    this.pollRepo(repoKey, owner, repo).catch((err: unknown) => {
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
        // Cache the PR node for extracting check details later
        this.lastPrNodes.set(session.id, prNode);

        const summary = parsePrNode(prNode, session.id);
        const prev = this.lastKnown.get(session.id);

        // Handle auto-fix state transitions
        this.handleAutoFixTransition(session.id, prev, summary, prNode, owner, repo);

        // Attach automation state before comparison and broadcast
        const withAutomation = this.attachAutomationState(summary);

        // Only include in broadcast if something changed
        if (!prev || !prStatusEqual(prev, summary)) {
          this.lastKnown.set(session.id, summary);
          updates.push(withAutomation);
        }
      } else {
        // PR disappeared from OPEN results — it may have been merged
        const prev = this.lastKnown.get(session.id);
        if (prev) {
          const mergedSummary: PrStatusSummary = { ...prev, prState: "merged" };
          this.lastKnown.set(session.id, mergedSummary);
          this.mergedSessions.add(session.id);
          this.lastPrNodes.delete(session.id);
          updates.push(mergedSummary);

          // Trigger post-merge archive
          if (this.onMergeDetectedCb) {
            this.onMergeDetectedCb(session.id).catch((err: unknown) => {
              console.error(`[pr-poller] Post-merge archive error for ${session.id}:`, err);
            });
          }
        } else if (this.pendingCatchUp.has(session.id)) {
          // First poll with no prior state — fire a one-time REST probe to check
          // if a PR already exists (e.g., merged before server restart).
          this.pendingCatchUp.delete(session.id);
          this.catchUpProbe(session.id, owner, repo, session.branch).catch((err: unknown) => {
            console.error(`[pr-poller] Catch-up probe error for ${session.id}:`, err);
          });
        }
      }
    }

    // Broadcast only if there are changes
    if (updates.length > 0) {
      this.sseBroadcast("pr_status", { updates });
    }
  }

  /**
   * One-time REST probe to check if a PR already exists for a session's branch.
   * Handles the case where a PR was merged/closed before the poller had any prior state
   * (e.g., after a server restart).
   */
  private async catchUpProbe(sessionId: string, owner: string, repo: string, branch: string): Promise<void> {
    const pr = await this.githubAuth.findPullRequestAnyState(owner, repo, branch);
    if (!pr) return; // No PR found — session stays in "ready" phase

    const isMerged = pr.merged_at !== null;
    const prState = isMerged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;

    // If the PR is still open, the next GraphQL poll will pick it up — skip
    if (prState === "open") return;

    const summary: PrStatusSummary = {
      sessionId,
      prNumber: pr.number,
      prUrl: pr.url,
      prTitle: pr.title,
      prState,
      baseBranch: pr.base,
      headBranch: branch,
      insertions: pr.additions,
      deletions: pr.deletions,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: false,
      autoMergeEnabled: false,
    };

    this.lastKnown.set(sessionId, summary);
    this.mergedSessions.add(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    // Trigger post-merge archive for merged PRs (not for closed-without-merge)
    if (isMerged && this.onMergeDetectedCb) {
      this.onMergeDetectedCb(sessionId).catch((err: unknown) => {
        console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
      });
    }
  }

  /** Handle auto-fix state transitions when CI status changes. */
  private handleAutoFixTransition(
    sessionId: string,
    prev: PrStatusSummary | undefined,
    current: PrStatusSummary,
    prNode: GraphQLPrNode,
    owner: string,
    repo: string,
  ): void {
    const state = this.autoFixStates.get(sessionId);
    if (!state?.enabled) return;

    const headSha = extractHeadSha(prNode);

    // Reset attempt counter when head SHA changes (new code pushed)
    if (headSha && state.lastHeadSha && headSha !== state.lastHeadSha) {
      state.attemptCount = 0;
      state.status = "idle";
    }
    if (headSha) {
      state.lastHeadSha = headSha;
    }

    // CI now success — auto-fix loop is done
    if (current.checks.state === "success" && state.status === "running") {
      state.status = "idle";
      return;
    }

    // CI now failure — trigger auto-fix if not exhausted
    if (
      current.checks.state === "failure" &&
      state.status !== "running" &&
      state.status !== "exhausted" &&
      state.attemptCount < MAX_AUTO_FIX_ATTEMPTS
    ) {
      const failedChecks = extractFailedCheckRuns(prNode);
      if (failedChecks.length > 0 && this.fetchAndFixCb) {
        // Trigger the fix asynchronously
        this.fetchAndFixCb(sessionId, owner, repo, failedChecks).catch((err: unknown) => {
          console.error(`[pr-poller] Auto-fix error for ${sessionId}:`, err);
        });
      }
    }

    // Check exhaustion
    if (state.attemptCount >= MAX_AUTO_FIX_ATTEMPTS) {
      state.status = "exhausted";
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
