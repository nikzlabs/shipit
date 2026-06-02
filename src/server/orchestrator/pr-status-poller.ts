/**
 * PrStatusPoller — orchestrator-level PR status poller.
 *
 * One poller per repo, not per session. All sessions sharing a repo share
 * one polling loop. Polls every 15 seconds using a single GitHub GraphQL
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
import type { GitManager } from "../shared/git.js";
import type { PrStatusSummary, AutoFixState, AutoMergeState, PrAutoMergeError } from "../shared/types/github-types.js";
import { parseGitHubRemote } from "./git-utils.js";
import {
  buildPrStatusQuery,
  extractFocusedPrNodes,
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
import { AutoConflictResolveManager, MAX_AUTO_RESOLVE_ATTEMPTS, type RebaseAndResolveCb } from "./auto-conflict-resolve-manager.js";
import { RemediationArbiter } from "./auto-remediation-arbiter.js";

// Re-export the pure parser helpers so existing callers
// (`pr-status-poller.test.ts`, `services/github-ci-fix.ts`) keep working
// without an import path change.
export { parsePrNode, extractHeadSha, extractFailedCheckRuns, extractChangedFiles };

/**
 * Per-repo polling cadences. The poller picks an interval per repo on every
 * supervisor tick based on the "most expectant" tracked session — fast when
 * CI is mid-flight or a push just landed, slow when everything has settled.
 *
 * See docs/064-pr-lifecycle-flow/plan.md "Polling budget" for the math and
 * the open-question answers that fixed these constants.
 *
 * `PR_STATUS_POLL_INTERVAL_MS` is the fast bucket. It is also the supervisor
 * tick: the supervisor wakes every FAST_INTERVAL_MS, then per repo decides
 * whether the SLOW_INTERVAL has elapsed before issuing a GraphQL call.
 */
export const PR_STATUS_POLL_INTERVAL_MS = 15_000;
/** Slow bucket: settled repos (success state, no recent push, mergeable known). */
export const PR_STATUS_SLOW_INTERVAL_MS = 120_000;
/**
 * After a session's auto-push fires, that session's repo stays at fast
 * cadence for this long — that's how long it takes CI to register and
 * usually finish on small PRs. After this elapses (and nothing else holds
 * the session at fast), the repo drops back to slow.
 */
const POST_PUSH_FAST_WINDOW_MS = 5 * 60_000;
/**
 * After the last viewer detaches, keep polling for this long before pausing.
 * Tolerates page reloads and short network blips so a quick reconnect doesn't
 * pay the cost of a re-burn. Aligned with the idle-enforcer's grace window
 * (see `idle-enforcer.ts:IDLE_GRACE_PERIOD_MS`) so both timers fire on the
 * same schedule from the user's perspective.
 */
const VIEWER_DETACH_GRACE_MS = 60_000;
/**
 * Cap for the bulk `pullRequests(first: N)` connection. Sessions whose PR is
 * past this cap fall through to the `verifyMissingPr` REST path. Kept at the
 * previous hard-coded value so behavior on big-PR-set repos is unchanged.
 */
const BULK_QUERY_MAX = 30;
/**
 * Floor for the bulk `pullRequests(first: N)` connection. Sized to absorb PRs
 * opened out-of-band on a tracked session's branch (e.g. user ran `gh pr
 * create` in the terminal) before that session has been observed at least
 * once, and to keep the post-restart first poll cheap when `lastKnown` is
 * empty. Tuned conservatively — bump if production sees too many REST
 * verify probes for sessions whose PRs are past the floor but inside the cap.
 *
 * See docs/155-pr-poll-query-scoping/plan.md Phase 1a.
 */
const BULK_QUERY_DISCOVERY_FLOOR = 5;

export class PrStatusPoller {
  private githubAuth: GitHubAuthManager;
  private sessionManager: SessionManager;
  private sseBroadcast: (event: string, data: unknown) => void;

  /**
   * Single supervisor timer (one for the whole poller, not one per repo). Wakes
   * every PR_STATUS_POLL_INTERVAL_MS, decides per repo whether enough time has
   * elapsed under its current cadence, then issues GraphQL calls for those
   * repos. `null` when the global gate is closed — see `globalGateOpen()`.
   */
  private supervisor: ReturnType<typeof setInterval> | null = null;
  /** repoKey (owner/repo) → timestamp when this repo last issued a GraphQL poll. */
  private lastPolledAt = new Map<string, number>();
  /** sessionId → timestamp of the last auto-push the orchestrator notified about. */
  private lastAutoPushAt = new Map<string, number>();
  /**
   * Timestamp when the last viewer detached. `0` means "currently has viewers
   * attached, or no viewer has ever been seen." Used to keep the supervisor
   * running through brief reconnects (within VIEWER_DETACH_GRACE_MS).
   */
  private lastViewerDetachAt = 0;
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
  /**
   * docs/146 — auto-resolve-conflicts state machine. Constructed only when
   * `runnerRegistry` is supplied (the feature needs the registry to look up
   * runners for the pre-attempt gate). Skipped wiring in degraded test
   * setups leaves the manager `undefined` and the feature inactive.
   */
  public autoConflictResolveManager: AutoConflictResolveManager | undefined;

  /** Optional: runner registry for server-initiated fix prompts. */
  private runnerRegistry?: SessionRunnerRegistry;
  /** Optional: called when a merged PR is detected — used to archive the session. */
  private onMergeDetectedCb?: (sessionId: string) => Promise<void>;
  /**
   * Optional: factory for a GitManager bound to a session's workspace dir.
   * When wired, the poller overrides GitHub's GraphQL `additions`/`deletions`
   * with a local `git diff --stat <base>...HEAD` so the PR card's diff numbers
   * match what the user sees when they click through to the diff dialog
   * (which is computed from the same local working tree). Without this,
   * GitHub's indexing lag after an auto-push can leave the card showing the
   * previous commit's numbers for a few polls until GitHub catches up.
   */
  private createGitManager?: (dir: string) => GitManager;

  /** sessionId → last known GraphQL PR node (cached for extracting check details). */
  private lastPrNodes = new Map<string, GraphQLPrNode>();

  /**
   * docs/146 — global enable getter for the auto-resolve loop. Captured so
   * the manager reads the setting at decision time rather than mirroring it
   * into per-session state. Optional — if absent, the manager treats the
   * feature as disabled.
   */
  private isAutoResolveEnabled: () => boolean;

  /**
   * docs/169 — global enable getter for the auto-fix-CI loop. Read at decision
   * time so toggling the global setting takes effect on the next poll/idle with
   * no per-session fan-out.
   */
  private isAutoFixEnabled: () => boolean;

  /**
   * docs/169 Workstream C — cross-automation arbiter shared by both remediation
   * managers (mutual exclusion + await-fresh-signal) and consulted by auto-merge
   * as a cheap precondition. One instance covers every session this poller
   * tracks.
   */
  public readonly remediationArbiter = new RemediationArbiter();

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sessionManager: SessionManager;
    sseBroadcast: (event: string, data: unknown) => void;
    runnerRegistry?: SessionRunnerRegistry;
    getSharedRepoDir?: (repoUrl: string) => string;
    fetchAndFixCb?: FetchAndFixCb;
    onMergeDetectedCb?: (sessionId: string) => Promise<void>;
    /**
     * When set, the poller swaps GitHub's GraphQL additions/deletions (which
     * lag a few seconds after each push while GitHub reindexes) for the same
     * locally-computed diff stats the click-through diff dialog uses, so the
     * card's +N/-N button can't show stale numbers.
     */
    createGitManager?: (dir: string) => GitManager;
    /** docs/146 — global gate getter for the auto-resolve loop. */
    isAutoResolveEnabled?: () => boolean;
    /** docs/146 — rebase-and-resolve callback. Late-bindable via the manager's setter. */
    rebaseAndResolveCb?: RebaseAndResolveCb;
    /** docs/169 — global gate getter for the auto-fix-CI loop. */
    isAutoFixEnabled?: () => boolean;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sessionManager = opts.sessionManager;
    this.sseBroadcast = opts.sseBroadcast;
    this.runnerRegistry = opts.runnerRegistry;
    this.onMergeDetectedCb = opts.onMergeDetectedCb;
    this.createGitManager = opts.createGitManager;
    this.isAutoResolveEnabled = opts.isAutoResolveEnabled ?? (() => false);
    this.isAutoFixEnabled = opts.isAutoFixEnabled ?? (() => false);

    // Bind broadcast as the change callback so collaborators don't need to
    // know about SSE plumbing — they just say "this session changed."
    const onSessionChange = (sessionId: string) => this.broadcastSessionStatus(sessionId);
    // docs/169 — auto-fix is now a global-toggle, arbiter-aware specialization
    // of the shared remediation base. Resolving runners needs the registry; in
    // degraded test setups without one, `getRunner` returns undefined and the
    // base's pre-attempt gate defers (matching the conflict manager's contract).
    this.autoFix = new AutoFixManager(
      onSessionChange,
      (sessionId) => opts.runnerRegistry?.get(sessionId),
      this.isAutoFixEnabled,
      opts.fetchAndFixCb,
      undefined,
      this.remediationArbiter,
    );
    this.autoMerge = new AutoMergeManager(this.githubAuth, onSessionChange);
    this.graceTracker = new CiGraceTracker(opts.getSharedRepoDir);
    // docs/146 — the manager requires the runner registry for its pre-attempt
    // gate (needs to look up `runner.running` / call `verifyRunningState`).
    // Without it, leave the manager unwired and the feature inactive — matches
    // the "skip wiring when runnerRegistry is absent" contract.
    if (opts.runnerRegistry) {
      const registry = opts.runnerRegistry;
      this.autoConflictResolveManager = new AutoConflictResolveManager(
        onSessionChange,
        (sessionId) => registry.get(sessionId),
        this.isAutoResolveEnabled,
        opts.rebaseAndResolveCb,
        undefined,
        this.remediationArbiter,
      );
    }
  }

  // ---- Global gate (Strategy 1) ----
  //
  // The supervisor only runs when the gate is open. The gate is open when ANY
  // of these is true:
  //   - a browser viewer is attached to any runner;
  //   - we're inside the disconnect grace window after the last viewer left;
  //   - an autonomous action is in flight on any tracked session (auto-fix
  //     running, ShipIt-managed auto-merge enabled, or a viewerless runner
  //     that's mid-turn — the headless flow).
  // When all three are false, the supervisor is stopped — zero GraphQL polls
  // fire until a viewer comes back or an autonomous flow kicks in.

  /**
   * True when at least one runner in the registry has a viewer attached.
   *
   * When no registry is wired (legacy callers, lightweight tests that don't
   * exercise the gate) treat the gate as always open so behavior matches the
   * pre-viewer-gating era. Production always wires the registry.
   */
  private anyViewersConnected(): boolean {
    const registry = this.runnerRegistry;
    if (!registry) return true;
    for (const id of registry.ids()) {
      const r = registry.get(id);
      if (r && r.viewerCount > 0) return true;
    }
    return false;
  }

  /**
   * True when an autonomous action that depends on PR/CI status updates is in
   * flight: an auto-fix loop, a managed auto-merge, or a headless agent turn
   * (running runner with no viewer — e.g. a child session spawned from chat).
   */
  private anyAutonomousActionInFlight(): boolean {
    for (const sessionId of this.sessionRepos.keys()) {
      if (this.mergedSessions.has(sessionId)) continue;

      const fix = this.autoFix.get(sessionId);
      if (fix?.status === "running") return true;

      const merge = this.autoMerge.get(sessionId);
      // ShipIt-managed auto-merge needs the poller to detect CI-success → merge.
      // Native auto-merge runs on GitHub's side and doesn't need our polling.
      if (merge?.enabled && merge.managed) return true;

      const runner = this.runnerRegistry?.get(sessionId);
      if (runner?.running && runner.viewerCount === 0) return true;
    }
    return false;
  }

  /**
   * The global gate. True when the supervisor should keep running.
   *
   * Note this is intentionally distinct from the per-repo cadence decision:
   * the gate decides whether polling runs at all; the cadence decides how
   * often. See docs/064-pr-lifecycle-flow/plan.md "Polling budget."
   */
  private globalGateOpen(): boolean {
    if (this.anyViewersConnected()) return true;
    if (this.anyAutonomousActionInFlight()) return true;
    // No viewers, no autonomous action — but maybe we're inside the
    // disconnect grace window (a viewer just left and may reconnect).
    if (
      this.lastViewerDetachAt > 0
      && Date.now() - this.lastViewerDetachAt < VIEWER_DETACH_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  // ---- Per-repo cadence (Strategy 2) ----
  //
  // For each tracked session on a repo, pick a per-session cadence based on
  // what we expect to change. The repo runs at the minimum (fastest) of its
  // tracked sessions' cadences. Fast = 15 s, slow = 120 s.

  private perSessionInterval(sessionId: string): number {
    // Autonomous action keep-alive: the loop needs prompt feedback.
    const fix = this.autoFix.get(sessionId);
    if (fix?.status === "running") return PR_STATUS_POLL_INTERVAL_MS;
    const merge = this.autoMerge.get(sessionId);
    if (merge?.enabled && merge.managed) return PR_STATUS_POLL_INTERVAL_MS;

    // Recent auto-push: CI is registering, fast cadence so the user (or the
    // auto-fix loop) sees the first non-none check promptly.
    const pushAt = this.lastAutoPushAt.get(sessionId);
    if (pushAt !== undefined && Date.now() - pushAt < POST_PUSH_FAST_WINDOW_MS) {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    const last = this.lastKnown.get(sessionId);
    if (!last) {
      // Haven't polled this session yet — fast so the first observation lands
      // quickly (the orchestrator usually pairs trackSession with a force).
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    if (last.checks.state === "pending") return PR_STATUS_POLL_INTERVAL_MS;

    // mergeable: UNKNOWN means GitHub is still computing — poll fast until it
    // resolves. "none" + unknown is the no-CI case and should stay slow.
    if (last.mergeable === "unknown" && last.checks.state !== "none") {
      return PR_STATUS_POLL_INTERVAL_MS;
    }

    return PR_STATUS_SLOW_INTERVAL_MS;
  }

  private repoInterval(repoKey: string): number {
    let interval = PR_STATUS_SLOW_INTERVAL_MS;
    for (const [sessionId, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      const sessionInterval = this.perSessionInterval(sessionId);
      if (sessionInterval < interval) interval = sessionInterval;
      if (interval === PR_STATUS_POLL_INTERVAL_MS) break;
    }
    return interval;
  }

  // ---- Public hooks (called by the orchestrator) ----

  /**
   * Notify the poller that a viewer has attached to a runner. Opens the
   * global gate (if it was closed) and clears the disconnect grace timer so
   * the supervisor stays running. The orchestrator's WS `attachToRunner`
   * pairs this with `forceRefreshSession(sessionId)` to make the user-
   * perceived freshness instant.
   */
  notifyViewerAttached(): void {
    this.lastViewerDetachAt = 0;
    this.ensureSupervisor();
  }

  /**
   * Notify the poller that a viewer has detached. If that was the last
   * viewer (and no autonomous action is keeping the gate open), arms the
   * grace timer; the supervisor will pause itself on the next tick after
   * VIEWER_DETACH_GRACE_MS elapses without a reconnect.
   */
  notifyViewerDetached(): void {
    if (this.anyViewersConnected()) return;
    if (this.lastViewerDetachAt === 0) this.lastViewerDetachAt = Date.now();
  }

  /**
   * Notify the poller that a session just initiated an auto-push to origin.
   * Bumps that session's cadence to fast for POST_PUSH_FAST_WINDOW_MS so CI
   * registration is observed promptly. Called from the orchestrator's
   * `scheduleAutoPush` after the push lands; tests call it directly.
   */
  notifyAutoPush(sessionId: string): void {
    this.lastAutoPushAt.set(sessionId, Date.now());
    // A push lands → we expect CI signal → keep the supervisor running so
    // the cadence picks it up. If the gate is otherwise closed (no viewer,
    // no autonomous action), this still doesn't open it on its own — the
    // user closed their tab, and waiting for them to come back is fine.
    if (this.globalGateOpen()) this.ensureSupervisor();
  }

  /**
   * Register a session as having an open PR.
   *
   * Issues an immediate one-shot poll if the global gate is open (i.e. the
   * caller is observing — the orchestrator's WS attach path pairs this with
   * a viewer attach). At server startup, when `app-lifecycle.ts` tracks
   * persisted sessions before any viewer has connected, the gate is closed
   * and tracking is just bookkeeping — the first poll happens on the next
   * viewer attach via `forceRefreshSession`.
   */
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

    if (this.globalGateOpen()) {
      this.ensureSupervisor();
      // Preserve the "first poll is immediate" contract from the old
      // per-repo-timer design — without it the freshly-tracked session
      // would wait up to one fast-tick (15 s) for its first observation.
      this.pollRepo(repoKey, parsed.owner, parsed.repo, { force: true }).catch((err: unknown) => {
        console.error(`[pr-poller] Error on initial poll ${repoKey}:`, err);
      });
    }
  }

  /**
   * Force a one-shot refresh for the repo that owns a session's PR status.
   * This is used for user-visible events (session activation, PR creation,
   * merge button) so the background cadence remains cheap without making the
   * UI wait for the next tick. A forced refresh is also the one path that
   * bypasses the global gate — a viewer is by definition active when this
   * runs, even if `notifyViewerAttached` hasn't landed yet.
   */
  async forceRefreshSession(
    sessionId: string,
    opts: { waitForMissingVerify?: boolean } = {},
  ): Promise<void> {
    const repoKey = this.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    // A user action is a strong activity signal, and a forced refresh should
    // not be suppressed by a previous "missing from bulk GraphQL" episode.
    this.lastViewerDetachAt = 0;
    this.ensureSupervisor();
    this.verifiedAbsent.delete(sessionId);

    const owner = repoKey.slice(0, slash);
    const repo = repoKey.slice(slash + 1);
    await this.pollRepo(repoKey, owner, repo, {
      force: true,
      waitForMissingVerify: opts.waitForMissingVerify ?? false,
    });
  }

  /**
   * Force a REST verification for a single session's PR. This is used after
   * ShipIt itself merges a PR, where waiting for the open-PR GraphQL view to
   * drop the branch can leave the UI stale for one or more poll intervals.
   */
  async forceVerifySessionPrState(sessionId: string): Promise<void> {
    const repoKey = this.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    const session = this.sessionManager.get(sessionId);
    if (!session?.branch) return;

    this.lastViewerDetachAt = 0;
    this.ensureSupervisor();
    this.verifiedAbsent.delete(sessionId);

    const owner = repoKey.slice(0, slash);
    const repo = repoKey.slice(slash + 1);
    await this.verifyMissingPr(sessionId, owner, repo, session.branch);
    this.verifiedAbsent.add(sessionId);
  }

  /** Untrack a session (archived, PR merged, etc.). */
  untrackSession(sessionId: string): void {
    const repoKey = this.sessionRepos.get(sessionId);
    this.sessionRepos.delete(sessionId);
    this.lastKnown.delete(sessionId);
    this.autoFix.delete(sessionId);
    this.autoMerge.delete(sessionId);
    this.autoConflictResolveManager?.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    this.lastPrNodes.delete(sessionId);
    this.inFlightVerify.delete(sessionId);
    this.verifiedAbsent.delete(sessionId);
    this.prTabActiveSessions.delete(sessionId);
    this.lastAutoPushAt.delete(sessionId);
    this.graceTracker.untrack(sessionId);

    if (repoKey && !this.repoHasTrackedSessions(repoKey)) {
      this.lastPolledAt.delete(repoKey);
    }
  }

  /**
   * docs/146 — re-broadcast every tracked session's PR snapshot. Used when
   * `autoResolveConflicts` flips false → true so existing sessions get the
   * (now-ungated) `autoResolve` block onto their snapshot without waiting
   * for a genuine PR-status change.
   */
  broadcastAllSnapshots(): void {
    const updates: PrStatusSummary[] = [];
    for (const [sessionId, summary] of this.lastKnown) {
      // Skip sessions whose terminal-state snapshots already promoted them
      // (the merged/closed bulk-view short-circuit handles them).
      if (this.mergedSessions.has(sessionId)) continue;
      updates.push(this.attachAutomationState(summary));
    }
    if (updates.length > 0) this.sseBroadcast("pr_status", { updates });
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
        // Treat PR-tab activation as a viewer signal so a paused supervisor
        // wakes up and the user sees the heavier conversation fields without
        // waiting a tick.
        this.lastViewerDetachAt = 0;
        this.ensureSupervisor();
        this.pollRepo(repoKey, owner, repo, { force: true }).catch((err: unknown) => {
          console.error(`[pr-poller] Error on PR-tab-activated poll ${repoKey}:`, err);
        });
      }
    }
  }

  /**
   * Pick the bulk `pullRequests(first: N)` connection size for this poll.
   *
   * `N` is the count of non-merged sessions tracked on this repo, raised to
   * the discovery floor (so a brand-new repo with one session still picks up
   * out-of-band PRs) and capped at `BULK_QUERY_MAX` (sessions past the cap
   * fall through to `verifyMissingPr`).
   *
   * See docs/155-pr-poll-query-scoping/plan.md Phase 1a.
   */
  private computeBulkFirst(repoKey: string): number {
    let trackedCount = 0;
    for (const [sessionId, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      trackedCount++;
    }
    return Math.min(BULK_QUERY_MAX, Math.max(trackedCount, BULK_QUERY_DISCOVERY_FLOOR));
  }

  /**
   * Collect PR numbers for the `focused${i}` aliases on this poll.
   *
   * A session contributes one focused alias iff its PR tab is active AND we
   * already know its PR number (from `lastKnown`). Sessions in
   * `prTabActiveSessions` whose first poll hasn't landed yet are skipped —
   * the next poll picks them up via the bulk view, then subsequent polls
   * upgrade to a focused alias with conversation fields.
   *
   * See docs/155-pr-poll-query-scoping/plan.md Phase 1b.
   */
  private collectFocusedPrNumbers(repoKey: string): number[] {
    const numbers: number[] = [];
    for (const sessionId of this.prTabActiveSessions) {
      if (this.sessionRepos.get(sessionId) !== repoKey) continue;
      if (this.mergedSessions.has(sessionId)) continue;
      const prNumber = this.lastKnown.get(sessionId)?.prNumber;
      if (typeof prNumber !== "number") continue;
      numbers.push(prNumber);
    }
    return numbers;
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

  /**
   * docs/169 — fan a runner "idle" event out to BOTH remediation managers so a
   * `deferred` attempt (the agent was busy when CI failed / a conflict landed)
   * re-evaluates the moment the runner frees up, rather than waiting for the
   * next poll. Called from the runner registry's "idle" subscription.
   */
  notifyRunnerIdle(sessionId: string): void {
    void this.autoFix.onRunnerIdle(sessionId).catch((err: unknown) => {
      console.error(`[pr-poller] auto-fix onRunnerIdle error for ${sessionId}:`, err);
    });
    void this.autoConflictResolveManager?.onRunnerIdle(sessionId).catch((err: unknown) => {
      console.error(`[pr-poller] auto-resolve onRunnerIdle error for ${sessionId}:`, err);
    });
  }

  /**
   * docs/169 — a WS-typed user input refreshes BOTH remediation automations'
   * attempt budgets (the user re-engaged with the session). Fanned out from the
   * WS dispatch switch in `index.ts`.
   */
  resetRemediationForUserActivity(sessionId: string): void {
    this.autoFix.resetForUserActivity(sessionId);
    this.autoConflictResolveManager?.resetForUserActivity(sessionId);
  }

  /** Get the cached GraphQL PR node for a session (for extracting check details). */
  getLastPrNode(sessionId: string): GraphQLPrNode | undefined {
    return this.lastPrNodes.get(sessionId);
  }

  /** Increment attempt count for auto-fix and set status to running. */
  markAutoFixRunning(sessionId: string): void {
    this.autoFix.markRunning(sessionId);
    // Auto-fix running ⇒ autonomous-action keep-alive: the loop wants prompt
    // CI feedback even if the user's tab is closed. Open the gate.
    this.ensureSupervisor();
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
    // Managed auto-merge depends on the poller to detect CI-success → merge.
    // Open the gate so a closed tab doesn't strand the flow.
    if (managed) this.ensureSupervisor();
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
    this.stopSupervisor();
    this.lastPolledAt.clear();
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
    // docs/146 — attach auto-resolve state ONLY when the global setting is
    // on. Belt-and-suspenders against a disabled user seeing a lingering
    // failure banner from the snapshot.
    const resolveState = this.autoConflictResolveManager?.get(summary.sessionId);
    if (resolveState && this.isAutoResolveEnabled()) {
      result = {
        ...result,
        autoResolve: {
          status: resolveState.status,
          attemptCount: resolveState.attemptCount,
          maxAttempts: MAX_AUTO_RESOLVE_ATTEMPTS,
          ...(resolveState.lastError !== undefined ? { lastError: resolveState.lastError } : {}),
          ...(resolveState.nextEligibleAt !== undefined ? { nextEligibleAt: resolveState.nextEligibleAt } : {}),
        },
      };
    }
    return result;
  }

  /**
   * Arm the supervisor if it isn't running and the global gate is open. A
   * single supervisor handles every tracked repo — there is no per-repo
   * timer. The supervisor wakes every fast tick and decides per repo whether
   * the slow interval has elapsed before issuing a GraphQL call.
   */
  private ensureSupervisor(): void {
    if (this.supervisor) return;
    if (!this.globalGateOpen()) return;
    this.supervisor = setInterval(() => this.supervisorTick(), PR_STATUS_POLL_INTERVAL_MS);
  }

  private stopSupervisor(): void {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
  }

  /**
   * Supervisor tick. Closes the gate if it should be closed; otherwise for
   * each tracked repo, polls iff the repo's per-repo interval has elapsed
   * since its last poll. Errors per repo are isolated so one repo's GraphQL
   * failure doesn't stop the others.
   */
  private supervisorTick(): void {
    if (!this.globalGateOpen()) {
      this.stopSupervisor();
      return;
    }

    const now = Date.now();
    const repoKeysSeen = new Set<string>();
    for (const [sessionId, repoKey] of this.sessionRepos) {
      if (this.mergedSessions.has(sessionId)) continue;
      if (repoKeysSeen.has(repoKey)) continue;
      repoKeysSeen.add(repoKey);

      const interval = this.repoInterval(repoKey);
      const last = this.lastPolledAt.get(repoKey) ?? 0;
      if (now - last < interval) continue;

      const slash = repoKey.indexOf("/");
      if (slash <= 0) continue;
      const owner = repoKey.slice(0, slash);
      const repo = repoKey.slice(slash + 1);
      this.pollRepo(repoKey, owner, repo).catch((err: unknown) => {
        console.error(`[pr-poller] Error polling ${repoKey}:`, err);
      });
    }
  }

  /** True when at least one non-merged session is still tracked on this repo. */
  private repoHasTrackedSessions(repoKey: string): boolean {
    for (const [sid, key] of this.sessionRepos) {
      if (key !== repoKey) continue;
      if (!this.mergedSessions.has(sid)) return true;
    }
    return false;
  }

  private async pollRepo(
    repoKey: string,
    owner: string,
    repo: string,
    opts: { force?: boolean; waitForMissingVerify?: boolean } = {},
  ): Promise<void> {
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

    // Record the poll attempt timestamp before the GraphQL call so the
    // supervisor's cadence check (in `supervisorTick`) doesn't fire a second
    // poll for the same repo while this one is in flight.
    this.lastPolledAt.set(repoKey, Date.now());

    // docs/155 Phase 1: shrink the query to what this poll actually needs.
    //   - `first: N` caps the bulk view at tracked-session count plus the
    //     discovery floor, so a 30-PR repo doesn't pay for 30 PRs of light
    //     data every tick.
    //   - `focusedPrNumbers` emits one heavy `focused${i}` alias per session
    //     whose PR tab is currently active, so conversation fields are pulled
    //     only for the PR the user is actually looking at — not the whole
    //     bulk view as it was pre-Phase-1.
    const first = this.computeBulkFirst(repoKey);
    const focusedPrNumbers = this.collectFocusedPrNumbers(repoKey);
    const query = buildPrStatusQuery({ first, focusedPrNumbers });
    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      query,
      { owner, name: repo },
    );

    // graphqlQuery returns the full JSON body, so the data is at the top level.
    // It already returns `null` on RATE_LIMITED responses (transport or
    // body-level), so a null result here means "do nothing" — never "all PRs
    // closed."
    const prNodes = (result as unknown as GraphQLResponse)?.data?.repository?.pullRequests?.nodes;
    if (!prNodes) return;

    // Walk any `focused${i}` aliases the query asked for. Conversation data
    // lives here, not on the bulk nodes.
    const focusedByPrNumber = extractFocusedPrNodes(result);

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

      const bulkNode = prByBranch.get(session.branch);

      if (bulkNode) {
        // PR is back in the bulk view — clear the "verified absent" marker so
        // a future disappearance triggers a fresh verify.
        this.verifiedAbsent.delete(session.id);
        // If this session had a focused alias on this poll, the focused node
        // carries the same fields as the bulk node plus conversation. Prefer
        // it so the summary picks up issue comments + review threads.
        const prNode = focusedByPrNumber.get(bulkNode.number) ?? bulkNode;
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

        // Prefer locally-computed diff stats over GitHub's GraphQL
        // additions/deletions. GitHub reindexes a PR's diff on its side a
        // few seconds (sometimes longer) after a push, so the GraphQL view
        // can lag — leaving the card's +N/-N button showing the previous
        // commit's numbers while the click-through diff dialog (computed
        // locally from `git diff base...HEAD`) already shows the latest.
        // Using the same local source for both keeps them consistent.
        if (this.createGitManager && session.workspaceDir) {
          try {
            const local = await this.createGitManager(session.workspaceDir)
              .diffStatVsBranch(summary.baseBranch);
            summary.insertions = local.insertions;
            summary.deletions = local.deletions;
          } catch {
            // Workspace gone (archived), bare repo without a checkout, etc.
            // Fall back to GitHub's numbers.
          }
        }

        const prev = this.lastKnown.get(session.id);

        // Carry forward the last known conversation when this poll didn't
        // fetch it (no focused alias for this session). Without this, the
        // change-detection gate would wipe the client's conversation as soon
        // as the PR tab loses focus.
        if (summary.issueComments === undefined && prev?.issueComments !== undefined) {
          summary.issueComments = prev.issueComments;
        }
        if (summary.reviewThreads === undefined && prev?.reviewThreads !== undefined) {
          summary.reviewThreads = prev.reviewThreads;
        }

        // Handle auto-fix state transitions. docs/169 — now async (the base's
        // pre-attempt gate may HTTP-roundtrip `verifyRunningState`); fire-and-
        // forget so one session's gate doesn't delay the rest of the poll.
        void this.autoFix.handleTransition(session.id, summary, prNode, owner, repo)
          .catch((err: unknown) => {
            console.error(`[pr-poller] Auto-fix handleTransition error for ${session.id}:`, err);
          });

        // Handle ShipIt-managed auto-merge. docs/169 — consult the arbiter as a
        // cheap precondition: don't drive a merge while a remediation claim is
        // held (a fix/resolve turn is mid-flight). Belt-and-suspenders — the
        // merge's own green-CI + mergeable preconditions already make collision
        // rare.
        if (!this.remediationArbiter.isClaimed(session.id)) {
          this.autoMerge.handleManaged(session.id, summary, owner, repo).catch((err: unknown) => {
            console.error(`[pr-poller] Managed auto-merge error for ${session.id}:`, err);
          });
        }

        // docs/146 — auto-resolve transitions. Fire-and-forget; the poller
        // loop is synchronous and we don't want one session's worker HTTP
        // roundtrip (verifyRunningState) to delay other sessions on the same
        // repo's poll iteration.
        if (this.autoConflictResolveManager) {
          const headShaForResolve = extractHeadSha(prNode) ?? "";
          this.autoConflictResolveManager
            .handleTransition(session.id, summary, summary.baseBranch, headShaForResolve)
            .catch((err: unknown) => {
              console.error(`[pr-poller] Auto-resolve handleTransition error for ${session.id}:`, err);
            });
        }

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
        if ((!opts.force && this.verifiedAbsent.has(session.id)) || this.inFlightVerify.has(session.id)) continue;
        this.inFlightVerify.add(session.id);
        const verify = this.verifyMissingPr(session.id, owner, repo, session.branch)
          .catch((err: unknown) => {
            console.error(`[pr-poller] REST verify error for ${session.id}:`, err);
          })
          .finally(() => {
            this.inFlightVerify.delete(session.id);
            this.verifiedAbsent.add(session.id);
          });
        if (opts.waitForMissingVerify) await verify;
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
    // docs/146 — release the manager's per-session state when the PR moves
    // to a terminal state (merged or closed-without-merge). Without this,
    // the state is dormant-but-harmless (subsequent polls short-circuit
    // before reaching the manager) but the map grows unbounded.
    this.autoConflictResolveManager?.delete(sessionId);
    this.autoFix.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    if (isMerged && this.onMergeDetectedCb) {
      this.onMergeDetectedCb(sessionId).catch((err: unknown) => {
        console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
      });
    }
  }
}
