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
  extractCurrentHeadOid,
  extractBaseSha,
  extractFailedCheckRuns,
  extractChangedFiles,
  prStatusEqual,
} from "./pr-status-parser.js";
import { AutoFixManager, MAX_AUTO_FIX_ATTEMPTS, type FetchAndFixCb } from "./auto-fix-manager.js";
import { AutoMergeManager } from "./auto-merge-manager.js";
import { CiGraceTracker } from "./ci-grace-tracker.js";
import { AutoConflictResolveManager, MAX_AUTO_RESOLVE_ATTEMPTS, type RebaseAndResolveCb } from "./auto-conflict-resolve-manager.js";
import { RemediationArbiter } from "./auto-remediation-arbiter.js";
import type { MergedPrInfo } from "./issue-lifecycle.js";
import { PrSessionTracker } from "./pr-session-tracker.js";
import { PollingGlobalGate } from "./polling-global-gate.js";
import {
  PrPollingSupervisor,
  PR_STATUS_POLL_INTERVAL_MS,
  PR_STATUS_SLOW_INTERVAL_MS,
} from "./pr-polling-supervisor.js";

// Re-export the cadence constants so existing importers
// (`pr-status-poller.test.ts`) keep working without an import path change.
export { PR_STATUS_POLL_INTERVAL_MS, PR_STATUS_SLOW_INTERVAL_MS };

/**
 * docs/196 — the facts the notify-on-merge watch acts on when a tracked
 * session's PR reaches a terminal state. Fired for both merged and
 * closed-without-merge so the watch can deliver the correct (distinct) signal.
 */
export interface PrTerminalStateInfo {
  /** The session whose PR reached a terminal state (the watched child). */
  sessionId: string;
  outcome: "merged" | "closed";
  prNumber: number;
  prUrl: string;
  prTitle: string;
  /** The PR's head branch. */
  branch: string;
  /** Merge commit SHA when known (merged outcome only). */
  mergeSha?: string;
}

// Re-export the pure parser helpers so existing callers
// (`pr-status-poller.test.ts`, `services/github-ci-fix.ts`) keep working
// without an import path change.
export { parsePrNode, extractHeadSha, extractCurrentHeadOid, extractBaseSha, extractFailedCheckRuns, extractChangedFiles };

export class PrStatusPoller {
  private githubAuth: GitHubAuthManager;
  private sessionManager: SessionManager;
  private sseBroadcast: (event: string, data: unknown) => void;

  /**
   * Per-session / per-repo state (lastKnown, sessionRepos, prTabActive, merged
   * promotion, REST-verify debouncing, cached PR nodes, push timestamps) plus
   * the pure query-shape helpers. docs/201 Phase P9.
   */
  private readonly tracker = new PrSessionTracker();
  /**
   * Viewer + in-flight-action global gate. The supervisor only runs while this
   * is open. Assigned in the constructor (needs autoFix/autoMerge). docs/201 P9.
   */
  private readonly gate: PollingGlobalGate;
  /**
   * Single polling timer + per-repo cadence selection. Assigned in the
   * constructor (needs the gate + collaborators). docs/201 Phase P9.
   */
  private readonly supervisor: PrPollingSupervisor;
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
   * docs/194 — called when a merged PR is detected, with the PR **body** in
   * scope (which `onMergeDetectedCb` lacks). Drives the issue-lifecycle
   * "→ completed" transition: parse `Closes/Refs <pointer>` lines and broker the
   * status/comment writes. Distinct from `onMergeDetectedCb` (sessionId-only,
   * archive path); both fire on the same merge.
   */
  private onMergedPr?: (info: MergedPrInfo) => Promise<void>;
  /**
   * docs/196 — called once when a tracked session's PR reaches a terminal state
   * (merged OR closed-without-merge), with the branch + PR ref in scope. Drives
   * the notify-on-merge watch: the handler checks whether THIS session has an
   * armed merge-watch and, if so, fires the parent's wake-turn + merge card.
   * Distinct from `onMergedPr` (merge-only, issue-lifecycle); this also fires on
   * closed-unmerged so a watch can deliver the distinct "closed" signal.
   */
  private onPrTerminalState?: (info: PrTerminalStateInfo) => Promise<void>;
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
     * docs/194 — merge-detected callback that receives the PR body, so the
     * issue-lifecycle "→ completed" parse can run where the body is in scope.
     */
    onMergedPr?: (info: MergedPrInfo) => Promise<void>;
    /**
     * docs/196 — fired once when a tracked session's PR reaches a terminal state
     * (merged or closed-without-merge). Wired to the notify-on-merge watch.
     */
    onPrTerminalState?: (info: PrTerminalStateInfo) => Promise<void>;
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
    this.onMergedPr = opts.onMergedPr;
    this.onPrTerminalState = opts.onPrTerminalState;
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
      // docs/186 — per-session pause gate. A session whose row carries
      // `autoFixCiPaused` opts out of the auto-fix loop even with the global
      // setting on. Read at decision time so a resume takes effect next poll.
      (sessionId) => !this.sessionManager.get(sessionId)?.autoFixCiPaused,
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

    // docs/201 Phase P9 — the gate and supervisor are split into sibling
    // modules. The gate reads viewer/autonomous-action state (needs the
    // collaborators constructed above); the supervisor owns the timer and
    // per-repo cadence, delegating the actual GraphQL poll back to `pollRepo`.
    this.gate = new PollingGlobalGate({
      runnerRegistry: opts.runnerRegistry,
      tracker: this.tracker,
      autoFix: this.autoFix,
      autoMerge: this.autoMerge,
      // Armed auto-resolve keeps the supervisor alive headlessly, same as
      // auto-fix. Undefined in degraded setups that skip wiring the manager
      // (no runner registry) — the gate treats that as "feature inactive."
      autoConflictResolve: this.autoConflictResolveManager,
      // docs/196 — a pending notify-on-merge watch must keep polling so the
      // child's human merge is observed and the parent woken, even with no
      // viewer anywhere. Read lazily per gate check (only when no viewer).
      hasPendingMergeWatch: () => this.sessionManager.listPendingMergeWatches().length > 0,
    });
    this.supervisor = new PrPollingSupervisor({
      gate: this.gate,
      tracker: this.tracker,
      autoFix: this.autoFix,
      autoMerge: this.autoMerge,
      pollRepo: (repoKey, owner, repo) => this.pollRepo(repoKey, owner, repo),
    });
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
    this.gate.clearDetachGrace();
    this.supervisor.ensure();
  }

  /**
   * Notify the poller that a viewer has detached. If that was the last
   * viewer (and no autonomous action is keeping the gate open), arms the
   * grace timer; the supervisor will pause itself on the next tick after
   * VIEWER_DETACH_GRACE_MS elapses without a reconnect.
   */
  notifyViewerDetached(): void {
    this.gate.armDetachGrace();
  }

  /**
   * Notify the poller that a session just initiated an auto-push to origin.
   * Bumps that session's cadence to fast for POST_PUSH_FAST_WINDOW_MS so CI
   * registration is observed promptly. Called from the orchestrator's
   * `scheduleAutoPush` after the push lands; tests call it directly.
   */
  notifyAutoPush(sessionId: string): void {
    this.tracker.lastAutoPushAt.set(sessionId, Date.now());
    // A push lands → we expect CI signal → keep the supervisor running so
    // the cadence picks it up. If the gate is otherwise closed (no viewer,
    // no autonomous action), this still doesn't open it on its own — the
    // user closed their tab, and waiting for them to come back is fine.
    if (this.gate.isOpen()) this.supervisor.ensure();
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
    this.tracker.sessionRepos.set(sessionId, repoKey);
    this.tracker.mergedSessions.delete(sessionId);
    this.tracker.verifiedAbsent.delete(sessionId);

    // Kick off workflow parsing in the background so the first poll's
    // grace-decision has the path filters available. Failures are silent —
    // the poller retries on every poll until a successful load.
    this.graceTracker.ensureWorkflowsLoaded(repoKey, repoUrl).catch(() => {});

    if (this.gate.isOpen()) {
      this.supervisor.ensure();
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
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    // A user action is a strong activity signal, and a forced refresh should
    // not be suppressed by a previous "missing from bulk GraphQL" episode.
    this.gate.clearDetachGrace();
    this.supervisor.ensure();
    this.tracker.verifiedAbsent.delete(sessionId);

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
   *
   * Note this deliberately does NOT route through `pollRepo` like
   * `forceRefreshSession` does: `pollRepo`'s bulk query is `states: [OPEN]`, and
   * GitHub's GraphQL view can still report a *just-merged* PR as open for a beat
   * (eventual consistency). `pollRepo` would then match it on the open path and
   * never reach `verifyMissingPr` — exactly the staleness this fast-path exists
   * to bypass with a definitive any-state REST probe. The cost of skipping
   * `pollRepo` is that we don't inherit its `canonicalApiTarget` retarget, so we
   * resolve the canonical owner ourselves (below) before the REST probe — else,
   * on a transferred/renamed repo, `findPullRequestAnyState` filters
   * `head=<old-owner>:<branch>` and matches nothing (SHI-159).
   */
  async forceVerifySessionPrState(sessionId: string): Promise<void> {
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    const session = this.sessionManager.get(sessionId);
    if (!session?.branch) return;

    this.gate.clearDetachGrace();
    this.supervisor.ensure();
    this.tracker.verifiedAbsent.delete(sessionId);

    const polledOwner = repoKey.slice(0, slash);
    const polledRepo = repoKey.slice(slash + 1);
    const { owner, repo } = await this.resolveCanonicalApiTarget(repoKey, polledOwner, polledRepo);
    const outcome = await this.verifyMissingPr(sessionId, owner, repo, session.branch);
    // Arm the single-probe debounce for every resting outcome EXCEPT a
    // superseded-PR suppression — see the matching note in `pollRepo`'s missing-
    // PR branch. A suppressed verify means the only PR on the branch is still the
    // re-armed session's OLD merged PR (docs/202); arming here would wedge
    // convergence if the NEW PR opens-and-merges before being observed open.
    if (outcome !== "suppressed") this.tracker.verifiedAbsent.add(sessionId);
  }

  /** Untrack a session (archived, PR merged, etc.). */
  untrackSession(sessionId: string): void {
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    this.tracker.untrack(sessionId);
    this.autoFix.delete(sessionId);
    this.autoMerge.delete(sessionId);
    this.autoConflictResolveManager?.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    this.graceTracker.untrack(sessionId);

    if (repoKey && !this.tracker.repoHasTrackedSessions(repoKey)) {
      this.supervisor.deleteRepoCadence(repoKey);
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
    for (const [sessionId, summary] of this.tracker.lastKnown) {
      // Skip sessions whose terminal-state snapshots already promoted them
      // (the merged/closed bulk-view short-circuit handles them).
      if (this.tracker.mergedSessions.has(sessionId)) continue;
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
    const was = this.tracker.prTabActiveSessions.has(sessionId);
    if (active) this.tracker.prTabActiveSessions.add(sessionId);
    else this.tracker.prTabActiveSessions.delete(sessionId);
    if (active === was) return;

    if (active) {
      const repoKey = this.tracker.sessionRepos.get(sessionId);
      const slash = repoKey?.indexOf("/") ?? -1;
      if (repoKey && slash > 0) {
        const owner = repoKey.slice(0, slash);
        const repo = repoKey.slice(slash + 1);
        // Treat PR-tab activation as a viewer signal so a paused supervisor
        // wakes up and the user sees the heavier conversation fields without
        // waiting a tick.
        this.gate.clearDetachGrace();
        this.supervisor.ensure();
        this.pollRepo(repoKey, owner, repo, { force: true }).catch((err: unknown) => {
          console.error(`[pr-poller] Error on PR-tab-activated poll ${repoKey}:`, err);
        });
      }
    }
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
      this.tracker.lastKnown.set(snapshot.sessionId, clean);
    }
    // docs/202 — re-seed superseded-PR suppression from persisted breadcrumbs so
    // a session re-armed before this restart (and not yet carrying a new PR)
    // can't have its OLD merged PR re-promote it to merged on the first poll.
    // The breadcrumb's `number` is exactly the value `reArm` recorded; it stays
    // suppressed only until a different-numbered PR appears, which is correct. A
    // re-armed session has `merged_at` cleared, so it is always in the visible
    // `list()` (Active, never resolved/capped) — no need to scan archived rows.
    for (const session of this.sessionManager.list()) {
      if (session.previousMergedPr) {
        this.tracker.supersededPrNumbers.set(session.id, session.previousMergedPr.number);
      }
    }
  }

  /**
   * Clear the persisted PR snapshot for a session (on unarchive, when a fresh
   * branch is created and the previous PR no longer applies). Broadcasts a
   * removal so connected clients drop their cached PR status / card.
   */
  clearPersisted(sessionId: string): void {
    this.tracker.lastKnown.delete(sessionId);
    this.tracker.mergedSessions.delete(sessionId);
    this.sessionManager.setPrStatus(sessionId, null);
    this.sseBroadcast("pr_status", { updates: [], removals: [sessionId] });
  }

  /**
   * docs/202 — re-arm a merged session whose branch has been rebased and gained
   * new work, so the poller treats it as a normal active session ready for a
   * fresh PR. **Silently** clears the poller's server-side terminal state and
   * resumes tracking.
   *
   * Deliberately does NOT reuse {@link clearPersisted}: that broadcasts a
   * destructive `pr_status { removals: [sessionId] }` over SSE, which races the
   * new WS `pr_lifecycle_update` card across two independent client channels —
   * if the removal lands *after* the card, it wipes the freshly-shown card and
   * the user is left with nothing (docs/202 "Transport"). Instead we clear state
   * quietly and rely on two non-racing convergence paths: the re-armed card
   * carries `previousMergedPr` so `updateCard` lets it override the terminal
   * guard, and reconnecting viewers converge via snapshot reconciliation.
   *
   * `supersededPrNumber` (the prior merged PR's number) is recorded so the
   * immediate forced poll that `trackSession` fires can't re-promote the OLD
   * merged PR via `verifyMissingPr` → `findPullRequestAnyState`. Set BEFORE
   * `trackSession` so the suppression is in place when that poll runs.
   */
  reArm(sessionId: string, supersededPrNumber?: number): void {
    this.tracker.lastKnown.delete(sessionId);
    this.tracker.lastPrNodes.delete(sessionId);
    this.tracker.mergedSessions.delete(sessionId);
    this.tracker.verifiedAbsent.delete(sessionId);
    this.sessionManager.setPrStatus(sessionId, null);
    if (typeof supersededPrNumber === "number") {
      this.tracker.supersededPrNumbers.set(sessionId, supersededPrNumber);
    }
    const repoUrl = this.sessionManager.get(sessionId)?.remoteUrl;
    if (repoUrl) this.trackSession(sessionId, repoUrl);
  }

  /** Get the current PR status for a session. */
  getStatus(sessionId: string): PrStatusSummary | undefined {
    return this.tracker.lastKnown.get(sessionId);
  }

  /** Get all current PR statuses (for SSE snapshot on connect). */
  getAllStatuses(): PrStatusSummary[] {
    return [...this.tracker.lastKnown.values()].map((s) => this.attachAutomationState(s));
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
    return this.tracker.lastPrNodes.get(sessionId);
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
  setAutoMergeManaged(sessionId: string, managed: boolean, settingsUrl?: string, reason?: string): void {
    this.autoMerge.setManaged(sessionId, managed, settingsUrl, reason);
    // Managed auto-merge depends on the poller to detect CI-success → merge.
    // Open the gate so a closed tab doesn't strand the flow.
    if (managed) this.supervisor.ensure();
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
    this.supervisor.destroy();
  }

  /** Broadcast current status for a single session. */
  private broadcastSessionStatus(sessionId: string): void {
    const status = this.tracker.lastKnown.get(sessionId);
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
          reason: mergeState.reason,
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
   * Resolve the owner/repo THIS poll's GitHub REST calls should target, given
   * the canonical `nameWithOwner` GitHub returned. When a repo is
   * transferred/renamed (e.g. nicolasalt/shipit → nikzlabs/shipit), the bulk
   * GraphQL poll keeps working under the cached (old) owner — GitHub's
   * `repository(owner, name)` follows the repo's redirect records — but the REST
   * merge-detection probe filters `head=<owner>:<branch>`, which matches nothing
   * once the head label carries the NEW owner, silently breaking merge
   * detection. `nameWithOwner` is the canonical identity; when it differs from
   * the key we polled under, return it so the REST calls below hit the new owner.
   *
   * Deliberately does NOT mutate any persisted or in-memory identity (session
   * `remoteUrl`, `sessionRepos`, the RepoStore record, or the bare-cache hash).
   * Those three must agree on one URL or the client orphans the sessions (it
   * groups them under a repo by exact-URL match) — an earlier version rewrote the
   * session rows alone and detached every session from its repo. The cached URL
   * stays consistent everywhere (git keeps working via GitHub's redirect); only
   * the owner/repo used for this poll's API calls is corrected, re-derived every
   * poll, statelessly. No-op when GitHub returns no `nameWithOwner` or it already
   * matches, so the steady-state path is unchanged.
   */
  private canonicalApiTarget(
    polledKey: string,
    polledOwner: string,
    polledRepo: string,
    nameWithOwner: string | undefined,
  ): { owner: string; repo: string } {
    const unchanged = { owner: polledOwner, repo: polledRepo };
    if (!nameWithOwner) return unchanged;
    const slash = nameWithOwner.indexOf("/");
    if (slash <= 0 || slash >= nameWithOwner.length - 1) return unchanged;
    const owner = nameWithOwner.slice(0, slash);
    const repo = nameWithOwner.slice(slash + 1);
    if (`${owner}/${repo}` === polledKey) return unchanged;
    return { owner, repo };
  }

  /**
   * Resolve the canonical owner/repo for a (possibly transferred/renamed) repo
   * via a lightweight `repository { nameWithOwner }` GraphQL probe, then apply
   * `canonicalApiTarget`. `pollRepo` gets `nameWithOwner` for free from its bulk
   * query, but the targeted single-session verify path bypasses `pollRepo` on
   * purpose (see `forceVerifySessionPrState`), so it must resolve the canonical
   * owner itself before its owner-qualified REST probe. Falls back to the polled
   * owner/repo whenever the probe yields nothing (unauthenticated, rate-limited,
   * network error, or no redirect), so the steady-state path is unchanged.
   */
  private async resolveCanonicalApiTarget(
    repoKey: string,
    owner: string,
    repo: string,
  ): Promise<{ owner: string; repo: string }> {
    const result = await this.githubAuth.graphqlQuery<{
      data?: { repository?: { nameWithOwner?: string } };
    }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }`,
      { owner, name: repo },
    );
    const nameWithOwner = result?.data?.repository?.nameWithOwner;
    return this.canonicalApiTarget(repoKey, owner, repo, nameWithOwner);
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
    this.supervisor.recordPolledAt(repoKey);

    // docs/155 Phase 1: shrink the query to what this poll actually needs.
    //   - `first: N` caps the bulk view at tracked-session count plus the
    //     discovery floor, so a 30-PR repo doesn't pay for 30 PRs of light
    //     data every tick.
    //   - `focusedPrNumbers` emits one heavy `focused${i}` alias per session
    //     whose PR tab is currently active, so conversation fields are pulled
    //     only for the PR the user is actually looking at — not the whole
    //     bulk view as it was pre-Phase-1.
    const first = this.tracker.computeBulkFirst(repoKey);
    const focusedPrNumbers = this.tracker.collectFocusedPrNumbers(repoKey);
    const coveragePrNumbers = this.tracker.collectCoveragePrNumbers(repoKey);
    const query = buildPrStatusQuery({ first, focusedPrNumbers, coveragePrNumbers });
    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      query,
      { owner, name: repo },
    );

    // graphqlQuery returns the full JSON body, so the data is at the top level.
    // It already returns `null` on RATE_LIMITED responses (transport or
    // body-level), so a null result here means "do nothing" — never "all PRs
    // closed."
    const repository = (result as unknown as GraphQLResponse)?.data?.repository;
    const prNodes = repository?.pullRequests?.nodes;
    if (!prNodes) return;

    // After a repo transfer/rename, target this poll's REST calls (merge verify,
    // auto-fix, auto-merge) at the canonical owner GitHub resolves to, while
    // leaving every persisted identity untouched (see canonicalApiTarget). The
    // bulk GraphQL above already worked via GitHub's redirect; only the
    // owner-qualified REST `head` filter needs the new owner.
    ({ owner, repo } = this.canonicalApiTarget(repoKey, owner, repo, repository.nameWithOwner));

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

    // Fold the per-number aliases (focused + coverage) into the branch map so a
    // tracked session's known PR is matched even when it fell outside the bulk
    // `first: N` window. Only OPEN aliases are surfaced this way: a known PR
    // that has since merged or closed is fetched by number regardless of state,
    // and parsePrNode always reports "open" — so treating it as a bulk match
    // would resurrect a merged card. Leaving merged/closed PRs absent here
    // routes them through verifyMissingPr, which owns terminal-state promotion.
    // A bulk node always wins (it is guaranteed OPEN by the connection filter).
    for (const node of focusedByPrNumber.values()) {
      if (node.state !== "OPEN") continue;
      if (!prByBranch.has(node.headRefName)) prByBranch.set(node.headRefName, node);
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
      (s) => this.tracker.sessionRepos.get(s.id) === repoKey && s.remoteUrl,
    );
    if (trackedSession?.remoteUrl) {
      await this.graceTracker.ensureWorkflowsLoaded(repoKey, trackedSession.remoteUrl);
    }

    for (const session of sessions) {
      const sessionRepoKey = this.tracker.sessionRepos.get(session.id);
      if (sessionRepoKey !== repoKey) continue;
      if (this.tracker.mergedSessions.has(session.id)) continue;
      if (!session.branch) continue;

      const bulkNode = prByBranch.get(session.branch);

      if (bulkNode) {
        // PR is back in the bulk view — clear the "verified absent" marker so
        // a future disappearance triggers a fresh verify.
        this.tracker.verifiedAbsent.delete(session.id);
        // docs/202 — a PR in the OPEN bulk view is necessarily the NEW PR for a
        // re-armed session (the superseded one is merged, never OPEN), so clear
        // any superseded-PR suppression and let normal tracking take over.
        this.tracker.supersededPrNumbers.delete(session.id);
        // If this session had a focused alias on this poll, the focused node
        // carries the same fields as the bulk node plus conversation. Prefer
        // it so the summary picks up issue comments + review threads.
        const prNode = focusedByPrNumber.get(bulkNode.number) ?? bulkNode;
        // Cache the PR node for extracting check details later
        this.tracker.lastPrNodes.set(session.id, prNode);

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

        const prev = this.tracker.lastKnown.get(session.id);

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
          const baseShaForResolve = extractBaseSha(prNode);
          this.autoConflictResolveManager
            .handleTransition(session.id, summary, summary.baseBranch, headShaForResolve, baseShaForResolve)
            .catch((err: unknown) => {
              console.error(`[pr-poller] Auto-resolve handleTransition error for ${session.id}:`, err);
            });
        }

        // Attach automation state before comparison and broadcast
        const withAutomation = this.attachAutomationState(summary);

        // Only include in broadcast if something changed
        if (!prev || !prStatusEqual(prev, summary)) {
          this.tracker.lastKnown.set(session.id, summary);
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
        if ((!opts.force && this.tracker.verifiedAbsent.has(session.id)) || this.tracker.inFlightVerify.has(session.id)) continue;
        this.tracker.inFlightVerify.add(session.id);
        // eslint-disable-next-line no-restricted-syntax -- fire-and-forget in the synchronous poll loop; the outcome decides whether to arm the debounce
        const verify = this.verifyMissingPr(session.id, owner, repo, session.branch)
          .then((outcome) => {
            // Arm the single-probe debounce for every resting outcome EXCEPT a
            // superseded-PR suppression. A `"suppressed"` verify means the only
            // PR on the branch is still the re-armed session's OLD merged PR
            // (docs/202) — the session's NEW PR hasn't been observed yet. If we
            // armed the debounce here, a NEW PR that opens AND merges entirely
            // between two polls (so it never appears in the OPEN bulk view to
            // clear `verifiedAbsent` — exactly the `gh pr create` → merge-on-
            // GitHub case, especially while the tab is closed) would never be
            // REST-verified again. The suppression also never clears (it only
            // clears when a *different*-numbered PR is observed), so the session
            // stays stuck with no PR card — the gray "Branch" badge — instead of
            // converging to GitHub's terminal `merged`/`closed` state. Leaving the
            // debounce un-armed for the suppressed case lets the next poll
            // re-verify and promote once `findPullRequestAnyState` returns the
            // different-numbered (now-terminal) PR.
            if (outcome !== "suppressed") this.tracker.verifiedAbsent.add(session.id);
          })
          .catch((err: unknown) => {
            console.error(`[pr-poller] REST verify error for ${session.id}:`, err);
            // On a transient REST/GraphQL error, arm the debounce as before so a
            // persistent failure doesn't re-probe every poll; the next forced
            // refresh (viewer attach / activation) clears it and retries.
            this.tracker.verifiedAbsent.add(session.id);
          })
          .finally(() => {
            this.tracker.inFlightVerify.delete(session.id);
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
   *
   * Returns the resting outcome so the caller can decide whether to arm the
   * `verifiedAbsent` single-probe debounce. Crucially, a `"suppressed"` result
   * (the superseded re-armed PR, docs/202) must NOT arm the debounce, or a NEW
   * PR that opens-and-merges between polls is never re-verified and the session
   * never converges to its terminal state (see the callers).
   */
  private async verifyMissingPr(
    sessionId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<"absent" | "open" | "terminal" | "suppressed"> {
    const pr = await this.githubAuth.findPullRequestAnyState(owner, repo, branch);
    if (!pr) return "absent";

    const isMerged = pr.merged_at !== null;
    const prState = isMerged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;

    // docs/202 — superseded-PR suppression for a re-armed session. While a
    // superseded (old merged) PR number is recorded, ignore a TERMINAL result
    // carrying that exact number — it is the PR the rebased branch already moved
    // past, and promoting it would clobber the re-armed card straight back to
    // merged. A result with a *different* number (the new PR opened, or a
    // genuinely different terminal PR) clears the suppression and is handled
    // normally below.
    const superseded = this.tracker.supersededPrNumbers.get(sessionId);
    if (superseded !== undefined && pr.number !== superseded) {
      this.tracker.supersededPrNumbers.delete(sessionId);
    } else if (superseded !== undefined && prState !== "open") {
      // Same-numbered terminal PR — the one we're suppressing. Treat as "no
      // current PR": leave the session active with its `ready` card standing.
      // Reported as `"suppressed"` so the caller does NOT arm `verifiedAbsent`:
      // the session's NEW PR hasn't appeared yet, and the next poll must stay
      // free to re-verify and catch it (even if it opens-and-merges between
      // polls, never showing in the OPEN bulk view).
      return "suppressed";
    }

    if (prState === "open") {
      const prev = this.tracker.lastKnown.get(sessionId);
      // A GraphQL-derived open snapshot is strictly richer than anything REST
      // gives us here (real check rollup, mergeable, conversation, files), so
      // never clobber it — the next GraphQL poll keeps it fresh.
      if (prev?.prState === "open") return "open";

      // Either a brand-new PR that the bulk GraphQL view hasn't indexed yet
      // (GitHub's eventual consistency right after `gh pr create` — the forced
      // refresh that PR creation kicks off lands here BEFORE the PR shows up in
      // the bulk query), or recovery from a past false merged/closed promotion.
      // Surface the open PR immediately from the REST result so the card
      // appears within ~1s instead of waiting up to a full slow poll (120s) for
      // GraphQL to catch up. The next GraphQL poll enriches checks / mergeable /
      // files / conversation and replaces this placeholder summary.
      this.tracker.mergedSessions.delete(sessionId);
      this.tracker.lastPrNodes.delete(sessionId);

      // Suppress a premature "mergeable" reading (and the merge button) while CI
      // is expected to register, mirroring the GraphQL path's grace override. We
      // don't have the head SHA from REST, so grace falls back to its time-based
      // window; the next GraphQL poll supplies the real SHA and reconciles.
      const checksState: PrStatusSummary["checks"]["state"] = this.graceTracker.shouldForcePending({
        sessionId,
        repoKey: `${owner}/${repo}`,
        repoUrl: this.sessionManager.get(sessionId)?.remoteUrl,
        headSha: "",
      })
        ? "pending"
        : "none";

      const summary: PrStatusSummary = {
        sessionId,
        prNumber: pr.number,
        prUrl: pr.url,
        prTitle: pr.title,
        prBody: pr.body,
        prState: "open",
        baseBranch: pr.base,
        headBranch: branch,
        insertions: pr.additions,
        deletions: pr.deletions,
        checks: { state: checksState, total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: "unknown",
        reviewDecision: "none",
        autoMergeEnabled: false,
      };
      this.tracker.lastKnown.set(sessionId, summary);
      this.sessionManager.setPrStatus(sessionId, summary);
      this.sseBroadcast("pr_status", { updates: [this.attachAutomationState(summary)] });
      return "open";
    }

    // Capture whether this session was already promoted to a terminal state
    // before this verify, so the merge-driven side effects (archive,
    // issue-lifecycle close, notify-on-merge) fire exactly once per real merge.
    //
    // `mergedSessions` is the in-memory fire-once edge, but `trackSession()`
    // wipes it — and the orchestrator re-tracks a session on every viewer
    // reconnect / session activation (see index.ts), then forces a refresh.
    // Relying on `mergedSessions` alone therefore re-promotes an already-merged
    // PR on each re-track and re-fires the terminal callbacks (re-archive,
    // `session_list` SSE fan-out, a bare-cache git refetch) without bound — the
    // production repeat observed at the slow-poll cadence ("Post-merge: marked
    // <id> as merged" logged dozens of times for one session). The persisted
    // last-known PR state survives both a re-track and a restart (loadPersisted
    // seeds it), so we also treat a PR already recorded terminal as terminal.
    // A merge first observed only after a mid-merge restart still fires once:
    // its persisted state was "open" at the last pre-restart poll.
    const prevState = this.tracker.lastKnown.get(sessionId)?.prState;
    const alreadyTerminal =
      this.tracker.mergedSessions.has(sessionId)
      || prevState === "merged"
      || prevState === "closed";

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
      reviewDecision: "none",
      autoMergeEnabled: false,
    };

    this.tracker.lastKnown.set(sessionId, summary);
    this.sessionManager.setPrStatus(sessionId, summary);
    // Closed-without-merge is terminal like a merge: stamp `closed_at` so the
    // session sinks out of the active sidebar into "Recently resolved". (Merge
    // sets `merged_at` via the onMergeDetectedCb archive path below.) markClosed
    // is a no-op if the PR already merged, so ordering vs. the merge path is safe.
    //
    // On the real transition, broadcast the updated `session_list` so viewers
    // demote the session into "Recently resolved" live — mirroring the merge
    // path's `session_list` broadcast in `onMergeDetectedCb`. The `pr_status`
    // event below only updates the PR card; without this `session_list`, the
    // session's `closedAt` (which drives the sidebar grouping) wouldn't reach
    // the client until a full reload re-bootstraps the list. `markClosed`
    // returns true only on the first stamp, so this fires once per close.
    if (prState === "closed" && this.sessionManager.markClosed(sessionId)) {
      this.sseBroadcast("session_list", { sessions: this.sessionManager.list() });
    }
    this.tracker.mergedSessions.add(sessionId);
    // docs/146 — release the manager's per-session state when the PR moves
    // to a terminal state (merged or closed-without-merge). Without this,
    // the state is dormant-but-harmless (subsequent polls short-circuit
    // before reaching the manager) but the map grows unbounded.
    this.autoConflictResolveManager?.delete(sessionId);
    this.autoFix.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    // docs/196 — fire the notify-on-merge watch hook for BOTH terminal outcomes.
    // Guarded by `!alreadyTerminal` so it fires once per terminal transition; the
    // watch's own `delivered`/`closed-unmerged` state machine is the second
    // fire-once guard (covers a restart that re-observes the same merge). The
    // handler no-ops when this session carries no armed watch.
    if (!alreadyTerminal && this.onPrTerminalState) {
      this.onPrTerminalState({
        sessionId,
        outcome: isMerged ? "merged" : "closed",
        prNumber: pr.number,
        prUrl: pr.url,
        prTitle: pr.title,
        branch,
        ...(pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}),
      }).catch((err: unknown) => {
        console.error(`[pr-poller] notify-on-merge watch handling error for ${sessionId}:`, err);
      });
    }

    if (isMerged && !alreadyTerminal) {
      // docs/218 — record the merged PR's head-branch tip as the session's
      // auto-reset safety anchor, BEFORE the merge side effects (archive,
      // issue-lifecycle close, notify-on-merge) fire. We deliberately store the
      // PR's `head.sha` rather than the session's current local HEAD: a turn
      // that ran between the GitHub merge and this detection would have advanced
      // local HEAD onto unmerged work, and anchoring on that would later let the
      // pre-turn reset discard it. Fail closed when the SHA is absent (malformed
      // REST response) — leaving `mergedHeadSha` NULL means the reset can't fire.
      if (pr.head_sha) {
        this.sessionManager.setMergedHeadSha(sessionId, pr.head_sha);
      } else {
        console.warn(`[pr-poller] merged PR #${pr.number} for ${sessionId} had no head.sha — auto-reset anchor not recorded`);
      }
      if (this.onMergeDetectedCb) {
        this.onMergeDetectedCb(sessionId).catch((err: unknown) => {
          console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
        });
      }
      // docs/194 — drive the issue-lifecycle "→ completed" transition from the
      // merged PR body. This is the parse site the body is in scope at (the
      // sessionId-only `onMergeDetectedCb` cannot be). Best-effort and
      // independent of the archive path above.
      if (this.onMergedPr) {
        this.onMergedPr({
          sessionId,
          prNumber: pr.number,
          prUrl: pr.url,
          prTitle: pr.title,
          body: pr.body,
        }).catch((err: unknown) => {
          console.error(`[pr-poller] Issue-lifecycle merge handling error for ${sessionId}:`, err);
        });
      }
    }

    return "terminal";
  }
}
