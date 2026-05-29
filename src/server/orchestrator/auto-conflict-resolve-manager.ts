/**
 * AutoConflictResolveManager — bookkeeping for the auto-resolve-conflicts
 * background loop. (docs/146)
 *
 * Driven by two triggers:
 *   - `handleTransition` runs from `PrStatusPoller` after each poll's summary
 *     is built. Edge / cap / cooldown / runner gates decide whether to fire
 *     the injected `rebaseAndResolveCb`.
 *   - `onRunnerIdle` runs from the runner registry's `"idle"` event. Only
 *     re-evaluates `deferred` states — cooldown-driven retry runs through
 *     `handleTransition` on the next poll.
 *
 * State writes are funnelled through `writeBack`, which is the ONLY place a
 * `status === "running"` becomes anything else for an attempt, and the only
 * place `attemptCount` is incremented. This keeps the state machine writes
 * in one place and avoids the ordering races between `up_to_date` /
 * `ServiceError(409)` and an out-of-band wrapper-side increment.
 *
 * Reads the global `autoResolveConflicts` setting at decision time rather
 * than mirroring it per-session, so toggling the setting takes effect on
 * the next poll/idle event with no fan-out.
 */

import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { WsServerMessage } from "../shared/types/ws-server-messages.js";
import { getErrorMessage } from "./validation.js";

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

export interface AutoConflictResolveState {
  /** Reset when head SHA changes or user activity resets. */
  attemptCount: number;
  lastHeadSha: string;
  status: "idle" | "running" | "exhausted" | "deferred";
  lastError?: string;
  /** Epoch ms; set on failure for the cooldown. */
  nextEligibleAt?: number;
  /**
   * Set by `resetForUserActivity` while a writeBack is in flight; applied at
   * the very end of writeBack. Without this, the in-flight wrapper's terminal
   * status would overwrite the reset that just happened — and a user who
   * re-engaged with the session would still see the failure banner pop after
   * their input.
   */
  pendingReset?: boolean;
  /**
   * Dedup tracker for back-to-back deferred WS emits — when the next
   * outcome is identical, skip the emit (state still writes). Keeps a
   * chronically-deferred session (e.g. stuck no-auth pre-flight) from
   * spamming `auto_resolve_result` on every poll.
   */
  lastEmittedDeferred?: string;
}

export class AutoConflictResolveManager {
  /** sessionId → state. */
  private states = new Map<string, AutoConflictResolveState>();
  /**
   * sessionId → last non-unknown mergeable value. UNKNOWN polls (common while
   * GitHub recomputes mergeability after a push) are ignored — without this,
   * a sticky conflict would oscillate `conflicting → unknown → conflicting`
   * and re-fire on every flop-back. Used by `onRunnerIdle` to know whether
   * the conflict is still standing without waiting for the next poll.
   */
  private lastKnownMergeable = new Map<string, "mergeable" | "conflicting">();

  constructor(
    private readonly onChange: (sessionId: string) => void,
    private readonly getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    private readonly isGlobalEnabled: () => boolean,
    private rebaseAndResolveCb?: RebaseAndResolveCb,
    /** Injectable clock so cooldown logic is testable. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Late-bind the rebase callback (constructor-time injection isn't always available). */
  setRebaseAndResolveCb(cb: RebaseAndResolveCb): void {
    this.rebaseAndResolveCb = cb;
  }

  /** Read per-session state. Undefined when never seen / dropped on resolution. */
  get(sessionId: string): AutoConflictResolveState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * Read the last non-unknown mergeable value for a session. Used by the
   * retry HTTP route to synchronously fire `handleTransition` after a reset
   * without waiting for the next poll (~15s) to bring the cached value back.
   */
  getLastKnownMergeable(sessionId: string): "mergeable" | "conflicting" | undefined {
    return this.lastKnownMergeable.get(sessionId);
  }

  /**
   * Read the best-known base branch for a session. Used by the retry HTTP
   * route which doesn't receive a fresh PrStatusSummary but needs to know
   * which ref to rebase onto when re-firing `handleTransition`.
   */
  getBaseBranch(sessionId: string): string | undefined {
    return this.baseBranchCache.get(sessionId);
  }

  /**
   * Drop both `states` and `lastKnownMergeable` for a session — called from
   * `PrStatusPoller.untrackSession` and from `verifyMissingPr`'s terminal-state
   * branch so the manager's maps don't leak when a PR merges/closes without
   * an explicit untrack.
   */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.lastKnownMergeable.delete(sessionId);
  }

  /**
   * Reset attempt budget on a WS-typed user input. NOT called from synthetic
   * `handleSendMessage` invocations (`init_preview_config`) or from
   * `runner.dispatch` system turns. See doc 146 "Reset on user activity".
   *
   * When NOT running, immediately clear `attemptCount` / `nextEligibleAt` /
   * `lastError` and set `status = "idle"` regardless of prior value
   * (including `"exhausted"`). When running, defer the reset via
   * `pendingReset` so the in-flight wrapper's writeBack doesn't overwrite it.
   */
  resetForUserActivity(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.status === "running") {
      state.pendingReset = true;
      return;
    }
    state.attemptCount = 0;
    delete state.nextEligibleAt;
    delete state.lastError;
    delete state.lastEmittedDeferred;
    state.status = "idle";
    this.onChange(sessionId);
  }

  /**
   * Called from `PrStatusPoller` after each poll's summary is built.
   *
   * Async because the pre-attempt gate's `verifyRunningState()` is an HTTP
   * roundtrip to the worker for container runners. Caller fires-and-forgets:
   *   `void manager.handleTransition(...).catch(err => log)`
   */
  async handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    baseBranch: string,
    headSha: string,
  ): Promise<void> {
    // Step 1 — UNKNOWN polls never participate. Don't touch cache, don't fire.
    if (current.mergeable === "unknown") return;

    // Step 2 — snapshot the pre-poll value BEFORE writing the cache.
    const prevKnown = this.lastKnownMergeable.get(sessionId);

    // Step 3 — write the new value unconditionally, BEFORE the enable check.
    // Cache stays accurate while disabled so first-enable polls have the right
    // baseline (test 16).
    this.lastKnownMergeable.set(sessionId, current.mergeable);
    // prevKnown is reserved for future logic (e.g. a "first-conflict-after-clean"
    // optimization). The current state machine drives entirely from `current.mergeable`,
    // the cache, and the cooldown — no edge filtering on `prevKnown`.
    void prevKnown;

    // Step 4 — global enable check. Cache the base branch BEFORE the
    // enable check is moot — onRunnerIdle needs it on first-enable too —
    // but only when we have a real value (don't overwrite with empty).
    if (baseBranch) this.baseBranchCache.set(sessionId, baseBranch);
    if (!this.isGlobalEnabled()) return;

    // Step 4a — initialize state on first-seen.
    let state = this.states.get(sessionId);
    if (!state) {
      state = { attemptCount: 0, lastHeadSha: headSha, status: "idle" };
      this.states.set(sessionId, state);
    }

    // Step 5 — running short-circuit. writeBack will land separately.
    if (state.status === "running") return;

    // Step 6 — exhausted is terminal until `resetForUserActivity` /
    // head-SHA change clears it.
    if (state.status === "exhausted") return;

    // Step 7 — head SHA change resets attempt budget (a new push is a new attempt set).
    if (state.lastHeadSha && headSha && headSha !== state.lastHeadSha) {
      state.attemptCount = 0;
      delete state.nextEligibleAt;
      delete state.lastError;
      delete state.lastEmittedDeferred;
      state.status = "idle";
    }
    state.lastHeadSha = headSha;

    // Step 8 — conflict resolved itself. Drop state so maps shrink.
    if (current.mergeable !== "conflicting") {
      this.states.delete(sessionId);
      this.lastKnownMergeable.delete(sessionId);
      this.onChange(sessionId);
      return;
    }

    // Step 9 — cap gate. Reaching this point means status was "idle" or
    // "deferred" — both earlier short-circuits returned for running /
    // exhausted, and step 7's SHA reset wrote "idle".
    if (state.attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS) {
      state.status = "exhausted";
      this.onChange(sessionId);
      return;
    }

    // Step 10 — cooldown gate.
    if (state.nextEligibleAt !== undefined && this.now() < state.nextEligibleAt) return;

    // Step 11 — pre-attempt runner gate.
    const runner = this.getRunner(sessionId);
    if (!runner) {
      if (state.status !== "deferred") {
        state.status = "deferred";
        this.onChange(sessionId);
      }
      return;
    }
    if (runner.running) {
      // Flip to deferred + emit FIRST so any re-entrant fire from
      // `verifyRunningState`'s zombie reset (which emits "idle" synchronously
      // when it resets `_isRunning`) sees the right status. Without this
      // ordering the synchronous `onRunnerIdle` would observe `status ===
      // "idle"` and short-circuit at step 1, missing the fire.
      const wasDeferred = state.status === "deferred";
      state.status = "deferred";
      if (!wasDeferred) this.onChange(sessionId);
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
      // verify reset running=true → false and the synchronous "idle" event
      // has already routed to `onRunnerIdle`, which (if eligible) fired the
      // callback. Return rather than fall through to step 12 — see the
      // load-bearing contract in doc 146 step 11.
      return;
    }

    // Step 12 — fire the attempt. Do NOT increment attemptCount here —
    // writeBack increments after the wrapper reports `didWork`. The started
    // envelope's `attempt` reads `attemptCount + 1` so started/result pair.
    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, baseBranch, state.attemptCount + 1);
  }

  /**
   * Called when a runner emits "idle". Re-evaluates `deferred` states the
   * moment the runner becomes free — without this the user would wait up to
   * 15s (next poll) for the auto-resolve to fire after their turn finishes.
   */
  async onRunnerIdle(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    // Cooldown-driven retry runs through handleTransition, not here.
    if (state?.status !== "deferred") return;
    if (!this.isGlobalEnabled()) return;

    const mergeable = this.lastKnownMergeable.get(sessionId);
    if (mergeable !== "conflicting") {
      // Conflict resolved itself while we waited — settle.
      state.status = "idle";
      this.onChange(sessionId);
      return;
    }

    // Re-run cap / cooldown / runner gates.
    if (state.attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS) {
      state.status = "exhausted";
      this.onChange(sessionId);
      return;
    }
    if (state.nextEligibleAt !== undefined && this.now() < state.nextEligibleAt) return;

    const runner = this.getRunner(sessionId);
    if (!runner) return; // stay deferred — next poll / next idle will retry
    if (runner.running) {
      // verifyRunningState is redundant here ("idle" event implies running=false
      // AND queue empty) but defensive — only matters if the runner emitted
      // "idle" spuriously.
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
    }

    const baseBranch = this.resolveBaseBranchFromCache(sessionId);
    if (!baseBranch) return; // shouldn't happen — caller always sets it via handleTransition first

    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, baseBranch, state.attemptCount + 1);
  }

  /**
   * Best-known base branch for a session, recorded by `handleTransition`.
   * Used by `onRunnerIdle` which doesn't receive a fresh `PrStatusSummary`
   * but still needs to know which ref to rebase onto.
   */
  private baseBranchCache = new Map<string, string>();

  /** Manager-internal: record the base branch under the session for later `onRunnerIdle` calls. */
  private resolveBaseBranchFromCache(sessionId: string): string | undefined {
    return this.baseBranchCache.get(sessionId);
  }

  /**
   * Fire the wrapper async, route the result through writeBack.
   * Emits the `auto_resolve_started` envelope at attempt start so a viewer
   * sees the loop kick in before the inner `rebase_started` arrives.
   */
  private fireAttempt(sessionId: string, baseBranch: string, attempt: number): void {
    this.baseBranchCache.set(sessionId, baseBranch);
    const cb = this.rebaseAndResolveCb;
    if (!cb) {
      // No callback wired — defensive: revert to idle so the next transition
      // can try again (e.g. once the lifecycle wiring lands).
      const state = this.states.get(sessionId);
      if (state) {
        state.status = "idle";
        this.onChange(sessionId);
      }
      return;
    }

    // Emit `auto_resolve_started` via the runner so every attached viewer
    // sees it AND it lands in the turn-event buffer for reconnect replay.
    const runner = this.getRunner(sessionId);
    runner?.emitMessage({
      type: "auto_resolve_started",
      sessionId,
      baseBranch,
      attempt,
    } as WsServerMessage);

    // Fire-and-forget: the callback drives an attempt that resolves
    // asynchronously, and `writeBack` lands all terminal-state writes. The
    // surrounding caller (`handleTransition` / `onRunnerIdle`) returns before
    // the attempt finishes so the poll loop / idle event doesn't block.
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
   * anything else for an attempt, and the only place `attemptCount` is
   * incremented. Emits the per-attempt `auto_resolve_result` envelope and
   * triggers the SSE re-broadcast via `onChange`.
   */
  private writeBack(sessionId: string, result: AutoResolveResult, attempt: number): void {
    const state = this.states.get(sessionId);
    if (!state) return; // session was deleted (untrack / closed PR) mid-attempt

    let emitOutcome: "success" | "exhausted" | "deferred" | "error" = result.outcome;
    let emitForcePushed: boolean | undefined;
    let emitLastError: string | undefined;

    if (result.outcome === "success") {
      state.attemptCount++;
      if (result.forcePushed) {
        state.status = "idle";
        delete state.lastError;
        delete state.nextEligibleAt;
        emitForcePushed = true;
      } else {
        // Lease failure / no-auth: record a synthetic label so the
        // exhausted-envelope banner has something to render. tryForcePush
        // doesn't return a structured signal; this is the closest we can do.
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

    // SSE snapshot refresh — even when the WS emit is suppressed below, the
    // snapshot ride is non-lossy (auto_resolve attaches to PrStatusSummary).
    this.onChange(sessionId);

    // WS emit gating. Suppressed when:
    //   - global setting flipped off mid-run (don't show a banner to a user
    //     who just disabled the feature)
    //   - the wrapper marked this outcome `suppressEmit` (up_to_date race —
    //     runRebaseFlow already emitted rebase_complete; an `auto_resolve_result
    //     deferred` after that would flash "rebased then deferred" in the UI)
    //   - deferred and identical to last (`lastEmittedDeferred` dedup)
    const runner = this.getRunner(sessionId);
    const suppressEmit = !this.isGlobalEnabled()
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

    // Apply pendingReset last so it wins over the writeBack's terminal write
    // — the user explicitly re-engaged with the session, so give them a
    // fresh budget even if this attempt just exhausted.
    if (state.pendingReset) {
      state.attemptCount = 0;
      delete state.nextEligibleAt;
      delete state.lastError;
      delete state.lastEmittedDeferred;
      state.status = "idle";
      delete state.pendingReset;
      this.onChange(sessionId);
    }
  }
}

