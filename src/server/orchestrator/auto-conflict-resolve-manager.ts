/**
 * AutoConflictResolveManager — auto-resolve-conflicts specialization of the
 * shared `AutoRemediationManager` base. (docs/146, refactored onto the shared
 * base in docs/169.)
 *
 * The generic state machine (per-session map, attempt cap, head-SHA reset,
 * status enum, cooldown gate, the load-bearing pre-attempt runner gate,
 * `resetForUserActivity`, `onChange`, `onRunnerIdle`, and the cross-automation
 * arbiter) lives in the base. This subclass supplies only the conflict-specific
 * config: the trigger predicate (`mergeable === "conflicting"`, ignoring
 * UNKNOWN polls), the cached-signal shape (last-known mergeable + base branch),
 * and the attempt accounting in `writeBack` — which is the ONLY place a
 * `running` status becomes anything else and the only place `attemptCount` is
 * incremented, so the ordering races between `up_to_date` / `ServiceError(409)`
 * and an out-of-band increment stay in one place.
 *
 * Reads the global `autoResolveConflicts` setting at decision time (via the
 * base's `isGlobalEnabled`) rather than mirroring it per-session.
 */

import type { PrStatusSummary, PrMergeableState } from "../shared/types/github-types.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { WsServerMessage } from "../shared/types/ws-server-messages.js";
import { getErrorMessage } from "./validation.js";
import { AutoRemediationManager, type RemediationState } from "./auto-remediation-manager.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";

/** Hard cap on the number of work-doing attempts per session per head SHA. */
export const MAX_AUTO_RESOLVE_ATTEMPTS = 3;
/** Cooldown after a failed attempt before the same session retries. */
export const AUTO_RESOLVE_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * Shorter cooldown after a deferred outcome (dirty tree, no-auth,
 * up_to_date race, etc.). Bounds the per-poll cost when the deferred
 * condition is sticky — without it, every 15s poll runs `verifyRunningState`
 * + wrapper construction + pre-flight checks.
 */
export const AUTO_RESOLVE_DEFERRED_COOLDOWN_MS = 60 * 1000;
/**
 * Settle window opened after a successful force-push. The push rewrites history,
 * so the head SHA changes; GitHub then returns `mergeable: "unknown"` while it
 * recomputes the test-merge, and there is a brief window where the GraphQL API
 * still serves the STALE pre-push `conflicting` verdict attached to the new
 * head. Without a gate, that stale verdict re-triggers the agent on the exact
 * conflicts it just resolved — and because the head SHA changed, the per-head
 * attempt budget resets too, so the 3-attempt cap never bites and the loop is
 * unbounded. The settle window (a) keeps the budget across our own push's SHA
 * change and (b) holds the re-fire via `nextEligibleAt` until the upstream has
 * had time to recompute. If the PR is still genuinely `conflicting` after the
 * window (base moved again), the next attempt fires normally and the cap holds.
 * Spans several poll intervals so a slow recompute still settles in-window.
 */
export const AUTO_RESOLVE_SETTLE_MS = 60 * 1000;

/**
 * Outcome shape returned by `runAutoResolveAttempt` to the manager.
 * `didWork` is the boundary the manager uses to decide attempt accounting —
 * pre-flight failures (couldn't even start) don't burn budget.
 */
export type AutoResolveResult =
  | { outcome: "success"; forcePushed: boolean; didWork: true }
  | { outcome: "error"; lastError: string; didWork: true }
  | { outcome: "deferred"; lastError?: string; didWork: false; /** Set on the runRebaseFlow up_to_date race so writeBack suppresses the contradicting `auto_resolve_result` envelope. */ suppressEmit?: boolean };

export type RebaseAndResolveCb = (
  sessionId: string,
  baseBranch: string,
) => Promise<AutoResolveResult>;

/**
 * Backwards-compatible alias for the shared `RemediationState`. The conflict
 * manager's original state shape is now exactly the shared shape.
 */
export type AutoConflictResolveState = RemediationState;

/** The conflict manager's poll signal: the mergeable verdict + the base branch. */
interface ConflictSignal {
  mergeable: PrMergeableState;
  baseBranch: string;
}

export class AutoConflictResolveManager extends AutoRemediationManager<ConflictSignal> {
  /**
   * sessionId → last non-unknown mergeable value. UNKNOWN polls (common while
   * GitHub recomputes mergeability after a push) are ignored, so this records
   * the last definite verdict — used by `cachedTriggerActive` (onRunnerIdle)
   * and exposed via `getLastKnownMergeable`.
   */
  private lastKnownMergeable = new Map<string, "mergeable" | "conflicting">();
  /** Best-known base branch per session, for `onRunnerIdle` re-fires + the retry route. */
  private baseBranchCache = new Map<string, string>();

  private rebaseAndResolveCb?: RebaseAndResolveCb;

  constructor(
    onChange: (sessionId: string) => void,
    getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    isGlobalEnabled: () => boolean,
    rebaseAndResolveCb?: RebaseAndResolveCb,
    /** Injectable clock so cooldown logic is testable. */
    now: () => number = () => Date.now(),
    /** docs/169 Workstream C — cross-automation arbiter (optional). */
    arbiter?: RemediationArbiter,
  ) {
    super({
      name: "auto-resolve",
      maxAttempts: MAX_AUTO_RESOLVE_ATTEMPTS,
      onChange,
      getRunner,
      isGlobalEnabled,
      now,
      ...(arbiter ? { arbiter } : {}),
    });
    this.rebaseAndResolveCb = rebaseAndResolveCb;
  }

  /** Late-bind the rebase callback (constructor-time injection isn't always available). */
  setRebaseAndResolveCb(cb: RebaseAndResolveCb): void {
    this.rebaseAndResolveCb = cb;
  }

  // ---- Conflict-specific public accessors (unchanged surface) -------------

  /**
   * Read the last non-unknown mergeable value for a session. Used by the
   * retry HTTP route to synchronously fire `handleTransition` after a reset
   * without waiting for the next poll.
   */
  getLastKnownMergeable(sessionId: string): "mergeable" | "conflicting" | undefined {
    return this.lastKnownMergeable.get(sessionId);
  }

  /** Read the best-known base branch for a session (used by the retry route). */
  getBaseBranch(sessionId: string): string | undefined {
    return this.baseBranchCache.get(sessionId);
  }

  // ---- Base hooks ---------------------------------------------------------

  protected classify(signal: ConflictSignal): "fire" | "resolved" | "ignore" {
    if (signal.mergeable === "unknown") return "ignore";
    return signal.mergeable === "conflicting" ? "fire" : "resolved";
  }

  protected cacheSignal(sessionId: string, signal: ConflictSignal): void {
    // signal.mergeable is never "unknown" here (classify returns "ignore" and
    // the base returns before caching).
    if (signal.mergeable === "conflicting" || signal.mergeable === "mergeable") {
      this.lastKnownMergeable.set(sessionId, signal.mergeable);
    }
    if (signal.baseBranch) this.baseBranchCache.set(sessionId, signal.baseBranch);
  }

  protected cachedTriggerActive(sessionId: string): boolean {
    return this.lastKnownMergeable.get(sessionId) === "conflicting";
  }

  protected rebuildSignalForIdle(sessionId: string): ConflictSignal | undefined {
    const baseBranch = this.baseBranchCache.get(sessionId);
    if (!baseBranch) return undefined;
    return { mergeable: "conflicting", baseBranch };
  }

  protected override onDelete(sessionId: string): void {
    this.lastKnownMergeable.delete(sessionId);
    this.baseBranchCache.delete(sessionId);
  }

  // ---- Public entry point (poller) ---------------------------------------

  /**
   * Called from `PrStatusPoller` after each poll's summary is built. Wraps the
   * generic base driver, translating the PR summary into a `ConflictSignal`.
   * Caller fires-and-forgets: `void manager.handleTransition(...).catch(...)`.
   * Keeps the original 4-arg signature (sessionId, summary, baseBranch, headSha)
   * that the poller and the unit-test suite call.
   */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    baseBranch: string,
    headSha: string,
  ): Promise<void> {
    return this.runTransition(sessionId, { mergeable: current.mergeable, baseBranch }, headSha);
  }

  // ---- Fire + terminal accounting -----------------------------------------

  protected fireAttempt(sessionId: string, signal: ConflictSignal, attempt: number): void {
    const baseBranch = signal.baseBranch;
    this.baseBranchCache.set(sessionId, baseBranch);
    const cb = this.rebaseAndResolveCb;
    if (!cb) {
      // No callback wired — defensive: revert to idle + release the arbiter
      // claim so the next transition can try again once wiring lands.
      const state = this.states.get(sessionId);
      if (state) {
        state.status = "idle";
        this.onChange(sessionId);
      }
      this.releaseClaim(sessionId, { pushed: false });
      return;
    }

    // Emit `auto_resolve_started` via the runner so every attached viewer sees
    // it AND it lands in the turn-event buffer for reconnect replay.
    const runner = this.cfg.getRunner(sessionId);
    runner?.emitMessage({
      type: "auto_resolve_started",
      sessionId,
      baseBranch,
      attempt,
    } as WsServerMessage);

    void this.runAttempt(sessionId, baseBranch, attempt, cb);
  }

  private async runAttempt(
    sessionId: string,
    baseBranch: string,
    attempt: number,
    cb: RebaseAndResolveCb,
  ): Promise<void> {
    try {
      const result = await cb(sessionId, baseBranch);
      this.writeBack(sessionId, result, attempt);
    } catch (err: unknown) {
      // Defensive: an unexpected crash from the wrapper most likely happened
      // mid-attempt, so we count it. Better to over-count occasionally than
      // to spin forever on a wrapper bug.
      this.writeBack(
        sessionId,
        { outcome: "error", lastError: getErrorMessage(err), didWork: true },
        attempt,
      );
    }
  }

  /**
   * Terminal-transition writer. The ONLY place `status === "running"` becomes
   * anything else for an attempt, the only place `attemptCount` is incremented,
   * and (docs/169) the single arbiter-release site. Emits the per-attempt
   * `auto_resolve_result` envelope and triggers the SSE re-broadcast.
   */
  private writeBack(sessionId: string, result: AutoResolveResult, attempt: number): void {
    const state = this.states.get(sessionId);
    if (!state) {
      // Session was deleted (untrack / closed PR) mid-attempt — still release
      // the arbiter claim so it doesn't wedge the session.
      this.releaseClaim(sessionId, { pushed: false });
      return;
    }

    let emitOutcome: "success" | "exhausted" | "deferred" | "error" = result.outcome;
    let emitForcePushed: boolean | undefined;
    let emitLastError: string | undefined;
    // docs/169 — a successful force-push changes the head SHA; arm the
    // arbiter's await-fresh-signal so neither automation re-fires until GitHub
    // surfaces the new code. Errors / deferrals / lease failures did NOT push.
    let pushed = false;

    if (result.outcome === "success") {
      state.attemptCount++;
      if (result.forcePushed) {
        state.status = "idle";
        delete state.lastError;
        // Open the settle window: our force-push changes the head SHA, and the
        // upstream verdict for the new head is briefly the stale pre-push value.
        // Hold any re-fire (and preserve the budget across the SHA change in
        // step 6) until GitHub has had time to recompute — otherwise the same
        // conflicts re-trigger immediately and the per-head cap never bites.
        state.settleUntil = this.now() + AUTO_RESOLVE_SETTLE_MS;
        state.nextEligibleAt = state.settleUntil;
        emitForcePushed = true;
        pushed = true;
      } else {
        // Lease failure / no-auth: record a synthetic label so the
        // exhausted-envelope banner has something to render.
        state.lastError = "force_push_failed";
        if (state.attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS) {
          state.status = "exhausted";
          emitOutcome = "exhausted";
          emitLastError = state.lastError;
        } else {
          state.status = "idle";
          // Without this cooldown, a sticky lease conflict re-fires every 15s
          // and burns the budget in <1min.
          state.nextEligibleAt = this.now() + AUTO_RESOLVE_COOLDOWN_MS;
        }
        emitForcePushed = false;
      }
    } else if (result.outcome === "error") {
      state.attemptCount++;
      state.lastError = result.lastError;
      if (state.attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS) {
        state.status = "exhausted";
        emitOutcome = "exhausted";
      } else {
        state.status = "idle";
        state.nextEligibleAt = this.now() + AUTO_RESOLVE_COOLDOWN_MS;
      }
      emitLastError = result.lastError;
    } else {
      // deferred — no increment, shorter cooldown
      if (result.lastError !== undefined) state.lastError = result.lastError;
      state.status = "deferred";
      state.nextEligibleAt = this.now() + AUTO_RESOLVE_DEFERRED_COOLDOWN_MS;
      emitLastError = result.lastError;
    }

    // docs/169 — release the arbiter claim on this single terminal path
    // (covers success / error / deferred / exhaustion / timeout, since the
    // wall-clock timeout surfaces as an `error` outcome through here).
    this.releaseClaim(sessionId, { pushed });

    // SSE snapshot refresh — even when the WS emit is suppressed below, the
    // snapshot ride is non-lossy (auto_resolve attaches to PrStatusSummary).
    this.onChange(sessionId);

    // WS emit gating. Suppressed when the setting flipped off mid-run, when the
    // wrapper marked the outcome `suppressEmit` (up_to_date race), or when a
    // deferred outcome is identical to the last (`lastEmittedDeferred` dedup).
    const runner = this.cfg.getRunner(sessionId);
    const suppressEmit = !this.cfg.isGlobalEnabled()
      || (result.outcome === "deferred" && "suppressEmit" in result && result.suppressEmit === true);
    if (result.outcome === "deferred" && state.lastEmittedDeferred === (result.lastError ?? "")) {
      // Same deferred outcome as last — skip the WS emit (state still wrote).
    } else if (!suppressEmit) {
      runner?.emitMessage({
        type: "auto_resolve_result",
        sessionId,
        outcome: emitOutcome,
        attempt,
        ...(emitForcePushed !== undefined ? { forcePushed: emitForcePushed } : {}),
        ...(emitLastError !== undefined ? { lastError: emitLastError } : {}),
      } as WsServerMessage);
    }

    if (result.outcome === "deferred") {
      state.lastEmittedDeferred = result.lastError ?? "";
    } else {
      delete state.lastEmittedDeferred;
    }

    // Apply pendingReset last so it wins over the writeBack's terminal write —
    // the user explicitly re-engaged with the session, so give them a fresh
    // budget even if this attempt just exhausted.
    this.applyPendingReset(sessionId, state);
  }
}
