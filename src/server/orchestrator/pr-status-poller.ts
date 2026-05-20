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
  PR_STATUS_QUERY_WITH_CONVERSATION,
  type GraphQLPrNode,
  type GraphQLResponse,
  parsePrNode,
  extractHeadSha,
  extractFailedCheckRuns,
  extractChangedFiles,
  prStatusEqual,
} from "./pr-status-parser.js";
import { AutoFixManager, MAX_AUTO_FIX_ATTEMPTS, type FetchAndFixCb } from "./auto-fix-manager.js";
import { AutoMergeManager } from "./auto-merge-manager.js";
import { CiGraceTracker } from "./ci-grace-tracker.js";

// Re-export the pure parser helpers so existing callers
// (`pr-status-poller.test.ts`, `services/github-ci-fix.ts`) keep working
// without an import path change.
export { parsePrNode, extractHeadSha, extractFailedCheckRuns, extractChangedFiles };

/**
 * Per-repo polling cadence. Bumped from 3s to 5s as a cost-control measure:
 * paired with the GraphQL query downsizing in `pr-status-parser.ts`, this
 * keeps a single actively-watched repo safely inside the 5,000-points/hour
 * primary rate-limit budget. Idle-pause + per-session REST verifies cover
 * the rest. See docs/064-pr-lifecycle-flow/plan.md for the budget math.
 */
const POLL_INTERVAL_MS = 5_000;
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
  /**
   * Sessions whose PR tab is the active right-panel tab (docs/133 Phase 4).
   * Reported over WS via `pr_tab_active`. When any tracked session on a repo is
   * here, that repo's poll fetches the heavier conversation fields (issue
   * comments + review threads); otherwise the light query is used.
   */
  private prTabActiveSessions = new Set<string>();
  /** Sessions whose PRs have been merged or closed — excluded from future queries. */
  private mergedSessions = new Set<string>();
  /**
   * Sessions whose REST verify is currently running. Prevents two overlapping
   * polls (or a verify + the next poll) from both firing the same REST call.
   */
  private inFlightVerify = new Set<string>();
  /**
   * Sessions whose absence from the bulk GraphQL result has already been
   * REST-verified during the current "missing" episode. Cleared when the PR
   * reappears in a GraphQL response. Without this, every poll would re-fire
   * a REST probe for any session whose PR is past the `first: N` cap or
   * whose PR's true state didn't match the bulk view (e.g. due to a transient
   * GraphQL error window).
   */
  private verifiedAbsent = new Set<string>();
  /** Last broadcast-side rate-limit flag — used to detect transitions. */
  private lastBroadcastLimited = false;

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
    this.verifiedAbsent.delete(sessionId);

    // Kick off workflow parsing in the background so the first poll's
    // grace-decision has the path filters available. Failures are silent —
    // the poller retries on every poll until a successful load.
    this.graceTracker.ensureWorkflowsLoaded(repoKey, repoUrl).catch(() => {});

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
    this.inFlightVerify.delete(sessionId);
    this.verifiedAbsent.delete(sessionId);
    this.prTabActiveSessions.delete(sessionId);
    this.graceTracker.untrack(sessionId);

    if (repoKey) {
      this.maybeStopPolling(repoKey);
    }
  }

  /**
   * Mark whether a session's PR tab is the active right-panel tab (docs/133
   * Phase 4). When turned on, kicks an immediate poll for the session's repo so
   * the conversation fields populate without waiting a full poll interval.
   */
  setPrTabActive(sessionId: string, active: boolean): void {
    const was = this.prTabActiveSessions.has(sessionId);
    if (active) this.prTabActiveSessions.add(sessionId);
    else this.prTabActiveSessions.delete(sessionId);
    if (active === was) return;

    if (active) {
      const repoKey = this.sessionRepos.get(sessionId);
      const slash = repoKey?.indexOf("/") ?? -1;
      if (repoKey && slash > 0) {
        const owner = repoKey.slice(0, slash);
        const repo = repoKey.slice(slash + 1);
        // Treat activation as user activity so an idle-paused repo resumes.
        this.recordClientActivity();
        this.pollRepo(repoKey, owner, repo).catch((err: unknown) => {
          console.error(`[pr-poller] Error on PR-tab-activated poll ${repoKey}:`, err);
        });
      }
    }
  }

  /** True when any tracked session on this repo has its PR tab active. */
  private repoHasActiveTab(repoKey: string): boolean {
    for (const sessionId of this.prTabActiveSessions) {
      if (this.sessionRepos.get(sessionId) === repoKey) return true;
    }
    return false;
  }

  /**
   * Seed in-memory `lastKnown` from persisted snapshots so archived sessions
   * appear in `getAllStatuses()` immediately after server restart. Called
   * once during app startup, before any clients connect.
   *
   * Deliberately does NOT seed `mergedSessions` from persisted merged/closed
   * snapshots: a previous orchestrator process could have written that state
   * from a rate-limit-induced false promotion, and trusting it would keep
   * the session permanently skipped by the poller. The first poll's bulk
   * GraphQL view + the REST verify fallback will re-confirm the state and
   * either re-add to `mergedSessions` (real merge) or unstick `lastKnown`
   * (PR is actually still open).
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

    // ---- Rate-limit gate ----
    // Read once and react to transitions. We never call GraphQL while in
    // limited state — that would just bounce off another 403 and waste
    // budget once the window resets.
    const rateLimit = this.githubAuth.getRateLimitState();
    const stillLimited = rateLimit.limited && (rateLimit.resetAt === null || rateLimit.resetAt > Date.now());

    if (stillLimited && !this.lastBroadcastLimited) {
      this.lastBroadcastLimited = true;
      this.sseBroadcast("gh_rate_limited", { resetAt: rateLimit.resetAt });
    } else if (!stillLimited && this.lastBroadcastLimited) {
      this.lastBroadcastLimited = false;
      this.sseBroadcast("gh_rate_limited_cleared", {});
    }

    if (stillLimited) return;
    if (this.canSkipPoll()) return;

    // docs/133 Phase 4: fetch the heavier conversation fields only when a
    // session on this repo has its PR tab open. Idle polls stay cheap.
    const includeConversation = this.repoHasActiveTab(repoKey);
    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      includeConversation ? PR_STATUS_QUERY_WITH_CONVERSATION : PR_STATUS_QUERY,
      { owner, name: repo },
    );

    // graphqlQuery returns the full JSON body, so the data is at the top level.
    // It already returns `null` on RATE_LIMITED responses (transport or
    // body-level), so a null result here means "do nothing" — never "all PRs
    // closed."
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

    // Ensure workflows are parsed for this repo before we make grace
    // decisions below. The first call kicks off the load; subsequent calls
    // are no-ops once cached. We use the first tracked session's remoteUrl
    // — all sessions on the same repoKey share the same remote.
    const trackedSession = sessions.find(
      (s) => this.sessionRepos.get(s.id) === repoKey && s.remoteUrl,
    );
    if (trackedSession?.remoteUrl) {
      await this.graceTracker.ensureWorkflowsLoaded(repoKey, trackedSession.remoteUrl);
    }

    for (const session of sessions) {
      const sessionRepoKey = this.sessionRepos.get(session.id);
      if (sessionRepoKey !== repoKey) continue;
      if (this.mergedSessions.has(session.id)) continue;
      if (!session.branch) continue;

      const prNode = prByBranch.get(session.branch);

      if (prNode) {
        // PR is back in the bulk view — clear the "verified absent" marker so
        // a future disappearance triggers a fresh verify.
        this.verifiedAbsent.delete(session.id);
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
            changedFiles: extractChangedFiles(prNode),
          });
          if (force) summary.checks.state = "pending";
        } else {
          // Any non-"none" state means GitHub registered something — no need
          // to keep the grace timer running.
          this.graceTracker.clearForSession(session.id);
        }

        const prev = this.lastKnown.get(session.id);

        // On a light poll the conversation fields aren't fetched (undefined).
        // Carry forward whatever we last knew so the change-detection gate
        // doesn't wipe the client's conversation when the PR tab loses focus.
        if (!includeConversation) {
          if (summary.issueComments === undefined && prev?.issueComments !== undefined) {
            summary.issueComments = prev.issueComments;
          }
          if (summary.reviewThreads === undefined && prev?.reviewThreads !== undefined) {
            summary.reviewThreads = prev.reviewThreads;
          }
        }

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
        // PR missing from bulk view — could be:
        //   (a) genuinely merged or closed,
        //   (b) past the `first: N` pagination cap,
        //   (c) GraphQL returned a partial response (rate limit, GitHub
        //       index lag, etc.) that's been classified as success here.
        //
        // (b) and (c) used to wrongly promote the session to "merged" on
        // every poll. We now NEVER promote synchronously — instead route
        // through a single REST verify per "missing" episode, debounced by
        // `verifiedAbsent` until the PR reappears in a bulk response.
        if (this.verifiedAbsent.has(session.id) || this.inFlightVerify.has(session.id)) continue;
        this.inFlightVerify.add(session.id);
        this.verifyMissingPr(session.id, owner, repo, session.branch)
          .catch((err: unknown) => {
            console.error(`[pr-poller] REST verify error for ${session.id}:`, err);
          })
          .finally(() => {
            this.inFlightVerify.delete(session.id);
            this.verifiedAbsent.add(session.id);
          });
      }
    }

    // Broadcast only if there are changes
    if (updates.length > 0) {
      this.sseBroadcast("pr_status", { updates });
    }
  }

  /**
   * Per-session REST verify of a PR's true state. Fires when a tracked
   * session's PR is missing from the bulk GraphQL response. The bulk view
   * can lie in several ways (rate-limit-truncated response, `first: N`
   * pagination cap, GitHub index lag) — REST gives us a definitive answer
   * for one PR at a time so we never promote to merged on absence alone.
   *
   * Behavior by outcome:
   *   - No PR found: do nothing. We never had bulk-view confirmation that
   *     this branch ever had a PR, and we won't fabricate one from REST
   *     silence either.
   *   - Open: if `lastKnown` is stuck on merged/closed (recovery from a
   *     past false promotion), clear the cached state and broadcast a
   *     removal so the UI drops the bogus PR card. Otherwise: leave state
   *     alone and wait for the next GraphQL poll to pick the PR back up.
   *   - Closed or merged: promote, persist, broadcast, and trigger the
   *     archive callback for merged.
   */
  private async verifyMissingPr(sessionId: string, owner: string, repo: string, branch: string): Promise<void> {
    const pr = await this.githubAuth.findPullRequestAnyState(owner, repo, branch);
    if (!pr) return;

    const isMerged = pr.merged_at !== null;
    const prState = isMerged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;

    if (prState === "open") {
      // Stuck-merged recovery: a previous (likely rate-limit-induced) false
      // promotion left lastKnown pinned to merged/closed. Clear it so the
      // UI drops the card; the next successful GraphQL poll will repopulate.
      const prev = this.lastKnown.get(sessionId);
      if (prev && (prev.prState === "merged" || prev.prState === "closed")) {
        this.lastKnown.delete(sessionId);
        this.mergedSessions.delete(sessionId);
        this.lastPrNodes.delete(sessionId);
        this.sessionManager.setPrStatus(sessionId, null);
        this.sseBroadcast("pr_status", { updates: [], removals: [sessionId] });
      }
      return;
    }

    // Terminal state — merged or closed-without-merge. Build a summary
    // mirroring the previous catchUpProbe shape (placeholder checks /
    // mergeable, since REST doesn't give us a rollup and the PR is now
    // past CI either way).
    const summary: PrStatusSummary = {
      sessionId,
      prNumber: pr.number,
      prUrl: pr.url,
      prTitle: pr.title,
      prBody: pr.body,
      prState,
      baseBranch: pr.base,
      headBranch: branch,
      insertions: pr.additions,
      deletions: pr.deletions,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown",
      autoMergeEnabled: false,
    };

    this.lastKnown.set(sessionId, summary);
    this.sessionManager.setPrStatus(sessionId, summary);
    this.mergedSessions.add(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    if (isMerged && this.onMergeDetectedCb) {
      this.onMergeDetectedCb(sessionId).catch((err: unknown) => {
        console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
      });
    }
  }
}
