/**
 * PrStatusPoller — orchestrator-level PR status poller.
 *
 * One poller per repo, not per session. All sessions sharing a repo share
 * one polling loop. Polls every 3 seconds using a single GitHub GraphQL
 * query per repo (OPEN PRs only). Broadcasts changes via SSE.
 *
 * Phase 2 additions: auto-fix state management, per-check failure details,
 * server-driven auto-fix loop.
 *
 * This file is the orchestration shell. The substantive pieces live in
 * dedicated modules so each can be reasoned about (and tested) in isolation:
 *
 * - `pr-status-parser.ts`   — pure GraphQL → domain helpers + equality
 * - `auto-fix-manager.ts`   — auto-fix state machine
 * - `auto-merge-manager.ts` — auto-merge state machine + REST merge loop
 * - `ci-grace-tracker.ts`   — "no checks yet" grace window + workflow detection
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { PrStatusSummary, AutoFixState, AutoMergeState, PrAutoMergeError } from "../shared/types/github-types.js";
import { parseGitHubRemote } from "./git-utils.js";
import {
  PR_STATUS_QUERY,
  type GraphQLPrNode,
  type GraphQLResponse,
  parsePrNode,
  extractHeadSha,
  extractFailedCheckRuns,
  prStatusEqual,
} from "./pr-status-parser.js";
import { AutoFixManager, MAX_AUTO_FIX_ATTEMPTS, type FetchAndFixCb } from "./auto-fix-manager.js";
import { AutoMergeManager } from "./auto-merge-manager.js";
import { CiGraceTracker } from "./ci-grace-tracker.js";

// Re-export the pure parser helpers so existing callers
// (`pr-status-poller.test.ts`, `services/github-ci-fix.ts`) keep working
// without an import path change.
export { parsePrNode, extractHeadSha, extractFailedCheckRuns };

const POLL_INTERVAL_MS = 3_000;
/** How long after the last client heartbeat before we consider the user idle (ms). */
const CLIENT_IDLE_TIMEOUT_MS = 30_000;

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

  /** Auto-fix state machine. */
  private autoFix: AutoFixManager;
  /** Auto-merge state machine + REST merge loop. */
  private autoMerge: AutoMergeManager;
  /** "No checks yet" grace window + per-repo workflow detection. */
  private graceTracker: CiGraceTracker;

  /** Optional: runner registry for server-initiated fix prompts. */
  private runnerRegistry?: SessionRunnerRegistry;
  /** Optional: called when a merged PR is detected — used to archive the session. */
  private onMergeDetectedCb?: (sessionId: string) => Promise<void>;

  /** sessionId → last known GraphQL PR node (cached for extracting check details). */
  private lastPrNodes = new Map<string, GraphQLPrNode>();

  /** Timestamp of the last client activity heartbeat. */
  private lastClientActivity = Date.now();

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sessionManager: SessionManager;
    sseBroadcast: (event: string, data: unknown) => void;
    runnerRegistry?: SessionRunnerRegistry;
    getSharedRepoDir?: (repoUrl: string) => string;
    fetchAndFixCb?: FetchAndFixCb;
    onMergeDetectedCb?: (sessionId: string) => Promise<void>;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sessionManager = opts.sessionManager;
    this.sseBroadcast = opts.sseBroadcast;
    this.runnerRegistry = opts.runnerRegistry;
    this.onMergeDetectedCb = opts.onMergeDetectedCb;

    // Bind broadcast as the change callback so collaborators don't need to
    // know about SSE plumbing — they just say "this session changed."
    const onSessionChange = (sessionId: string) => this.broadcastSessionStatus(sessionId);
    this.autoFix = new AutoFixManager(onSessionChange, opts.fetchAndFixCb);
    this.autoMerge = new AutoMergeManager(this.githubAuth, onSessionChange);
    this.graceTracker = new CiGraceTracker(opts.getSharedRepoDir);
  }

  /** Record a heartbeat from a connected client — resets the idle timer. */
  recordClientActivity(): void {
    this.lastClientActivity = Date.now();
  }

  /** True when no client heartbeat has arrived within the idle timeout. */
  private isClientIdle(): boolean {
    return Date.now() - this.lastClientActivity > CLIENT_IDLE_TIMEOUT_MS;
  }

  /**
   * True when polling can be skipped — the user is idle AND no CI checks
   * are currently pending across all tracked sessions.
   */
  private canSkipPoll(): boolean {
    if (!this.isClientIdle()) return false;

    // If any tracked session has pending CI, keep polling so auto-fix /
    // auto-merge can react promptly.
    for (const [sessionId] of this.sessionRepos) {
      if (this.mergedSessions.has(sessionId)) continue;
      const status = this.lastKnown.get(sessionId);
      if (status?.checks.state === "pending") return false;
    }

    return true;
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
    this.autoFix.delete(sessionId);
    this.autoMerge.delete(sessionId);
    this.lastPrNodes.delete(sessionId);
    this.pendingCatchUp.delete(sessionId);
    this.graceTracker.untrack(sessionId);

    if (repoKey) {
      this.maybeStopPolling(repoKey);
    }
  }

  /**
   * Seed in-memory `lastKnown` from persisted snapshots so archived sessions
   * appear in `getAllStatuses()` immediately after server restart. Called
   * once during app startup, before any clients connect.
   */
  loadPersisted(): void {
    const persisted = this.sessionManager.getAllPrStatuses();
    for (const snapshot of persisted) {
      // Strip runtime-only state — autoFix / autoMerge live in their own maps
      // and shouldn't leak in via persisted JSON.
      const clean: PrStatusSummary = { ...snapshot };
      delete clean.autoFix;
      delete clean.autoMerge;
      this.lastKnown.set(snapshot.sessionId, clean);
      if (clean.prState === "merged" || clean.prState === "closed") {
        this.mergedSessions.add(snapshot.sessionId);
      }
    }
  }

  /**
   * Clear the persisted PR snapshot for a session (on unarchive, when a fresh
   * branch is created and the previous PR no longer applies). Broadcasts a
   * removal so connected clients drop their cached PR status / card.
   */
  clearPersisted(sessionId: string): void {
    this.lastKnown.delete(sessionId);
    this.mergedSessions.delete(sessionId);
    this.sessionManager.setPrStatus(sessionId, null);
    this.sseBroadcast("pr_status", { updates: [], removals: [sessionId] });
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
    return this.autoFix.get(sessionId);
  }

  /** Set auto-fix enabled/disabled for a session. Returns the updated state. */
  setAutoFixEnabled(sessionId: string, enabled: boolean): AutoFixState {
    return this.autoFix.setEnabled(sessionId, enabled);
  }

  /** Get the cached GraphQL PR node for a session (for extracting check details). */
  getLastPrNode(sessionId: string): GraphQLPrNode | undefined {
    return this.lastPrNodes.get(sessionId);
  }

  /** Increment attempt count for auto-fix and set status to running. */
  markAutoFixRunning(sessionId: string): void {
    this.autoFix.markRunning(sessionId);
  }

  // ---- Auto-merge state management ----

  /** Get auto-merge state for a session. */
  getAutoMergeState(sessionId: string): AutoMergeState | undefined {
    return this.autoMerge.get(sessionId);
  }

  /** Set auto-merge enabled/disabled for a session. */
  setAutoMergeEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    return this.autoMerge.setEnabled(sessionId, enabled);
  }

  /** Mark auto-merge as ShipIt-managed (GitHub native unavailable). */
  setAutoMergeManaged(sessionId: string, managed: boolean, settingsUrl?: string): void {
    this.autoMerge.setManaged(sessionId, managed, settingsUrl);
  }

  /** Set an auto-merge error (toggle reverts to OFF). */
  setAutoMergeError(sessionId: string, error: PrAutoMergeError): void {
    this.autoMerge.setError(sessionId, error);
  }

  /** Set the preferred merge method for a session. */
  setMergeMethod(sessionId: string, method: "squash" | "merge" | "rebase"): void {
    this.autoMerge.setMergeMethod(sessionId, method);
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
    const fixState = this.autoFix.get(summary.sessionId);
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
    const mergeState = this.autoMerge.get(summary.sessionId);
    if (mergeState) {
      result = {
        ...result,
        autoMerge: {
          enabled: mergeState.enabled,
          mergeMethod: mergeState.mergeMethod,
          managed: mergeState.managed,
          settingsUrl: mergeState.settingsUrl,
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
    if (this.canSkipPoll()) return;

    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      PR_STATUS_QUERY,
      { owner, name: repo },
    );

    // graphqlQuery returns the full JSON body, so the data is at the top level
    const prNodes = (result as unknown as GraphQLResponse)?.data?.repository?.pullRequests?.nodes;
    if (!prNodes) return;

    // Build a map of headRefName → PR node for matching, and observe whether
    // ANY PR in this repo has CI checks reported. Once true, stays true: this
    // sticky signal lets us correctly classify a brand-new PR as "pending"
    // even before its workflow runs have registered, and it covers external
    // CI (Vercel, third-party status checks) that wouldn't show up via local
    // .github/workflows inspection.
    const prByBranch = new Map<string, GraphQLPrNode>();
    let observedChecksThisPoll = false;
    for (const node of prNodes) {
      prByBranch.set(node.headRefName, node);
      if (!observedChecksThisPoll) {
        const contexts = node.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes;
        if (contexts && contexts.length > 0) observedChecksThisPoll = true;
      }
    }
    if (observedChecksThisPoll) {
      this.graceTracker.markRepoHasChecks(repoKey);
    }

    // Match PRs to sessions by branch name
    const updates: PrStatusSummary[] = [];
    const sessions = this.sessionManager.list();

    for (const session of sessions) {
      const sessionRepoKey = this.sessionRepos.get(session.id);
      if (sessionRepoKey !== repoKey) continue;
      if (this.mergedSessions.has(session.id)) continue;
      if (!session.branch) continue;

      const prNode = prByBranch.get(session.branch);

      if (prNode) {
        // Cache the PR node for extracting check details later
        this.lastPrNodes.set(session.id, prNode);

        const summary = parsePrNode(prNode, session.id);
        const headSha = extractHeadSha(prNode) ?? "";

        // If GitHub reports no checks yet but we have any signal the repo
        // runs CI (workflow files in the local clone, or checks observed on
        // any PR in this repo previously), treat as "pending" — checks just
        // haven't registered yet. Without this override, the client sees
        // state: "none" and unconditionally enables the squash-and-merge
        // button, which is wrong while CI is still spinning up.
        //
        // The override is time-boxed via CiGraceTracker; after the grace
        // window elapses without GitHub registering any check for the current
        // head SHA, we accept that no workflows apply to this PR and let the
        // state fall back to "none" (the client treats that as "CI doesn't
        // apply, mergeable"). A new push (new head SHA) resets the timer.
        if (summary.checks.state === "none") {
          const force = this.graceTracker.shouldForcePending({
            sessionId: session.id,
            repoKey,
            repoUrl: session.remoteUrl,
            headSha,
          });
          if (force) summary.checks.state = "pending";
        } else {
          // Any non-"none" state means GitHub registered something — no need
          // to keep the grace timer running.
          this.graceTracker.clearForSession(session.id);
        }

        const prev = this.lastKnown.get(session.id);

        // Handle auto-fix state transitions
        this.autoFix.handleTransition(session.id, summary, prNode, owner, repo);

        // Handle ShipIt-managed auto-merge
        this.autoMerge.handleManaged(session.id, summary, owner, repo).catch((err: unknown) => {
          console.error(`[pr-poller] Managed auto-merge error for ${session.id}:`, err);
        });

        // Attach automation state before comparison and broadcast
        const withAutomation = this.attachAutomationState(summary);

        // Only include in broadcast if something changed
        if (!prev || !prStatusEqual(prev, summary)) {
          this.lastKnown.set(session.id, summary);
          this.sessionManager.setPrStatus(session.id, summary);
          updates.push(withAutomation);
        }
      } else {
        // PR disappeared from OPEN results — it may have been merged
        const prev = this.lastKnown.get(session.id);
        if (prev) {
          const mergedSummary: PrStatusSummary = { ...prev, prState: "merged" };
          this.lastKnown.set(session.id, mergedSummary);
          this.sessionManager.setPrStatus(session.id, mergedSummary);
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
      // catchUpProbe only fires for merged/closed PRs (returns early for open)
      // — body isn't shown for terminal states, so we don't pay the extra
      // REST call to fetch it. The next GraphQL poll would re-populate it
      // anyway if the PR were re-opened.
      prBody: "",
      prState,
      baseBranch: pr.base,
      headBranch: branch,
      insertions: pr.additions,
      deletions: pr.deletions,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      // PR is merged/closed — mergeability is moot. Use "unknown" since we
      // didn't actually query GraphQL for it.
      mergeable: "unknown",
      autoMergeEnabled: false,
    };

    this.lastKnown.set(sessionId, summary);
    this.sessionManager.setPrStatus(sessionId, summary);
    this.mergedSessions.add(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    // Trigger post-merge archive for merged PRs (not for closed-without-merge)
    if (isMerged && this.onMergeDetectedCb) {
      this.onMergeDetectedCb(sessionId).catch((err: unknown) => {
        console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
      });
    }
  }
}
