/**
 * AutoRemediationManager — the shared base for poller-driven, attempt-budgeted,
 * agent-backed PR remediation. (docs/169)
 *
 * Both PR automations that "do something to the PR on the user's behalf when
 * CI/merge state changes" — auto-fix CI and auto-resolve conflicts — were built
 * incrementally and drifted into two copies of the same skeleton: a per-session
 * `Map`, an attempt cap, a head-SHA-change reset, a `status` enum, an `onChange`
 * SSE broadcast, a cooldown gate, and a pre-attempt runner gate. This base owns
 * that skeleton ONCE; the per-automation differences (the trigger predicate, the
 * fire callback, the cooldowns, the attempt accounting, and the cached-signal
 * shape) are expressed as named hooks rather than incidental drift.
 *
 * Template-method design: `handleTransition` and `onRunnerIdle` are the generic
 * state-machine drivers; subclasses supply `classify`, `cacheSignal`,
 * `cachedTriggerActive`, `rebuildSignalForIdle`, `fireAttempt`, and `onDelete`.
 * The subtle ordering the conflict manager documented (the step-11 deferred-emit
 * before `verifyRunningState`, the synchronous "idle" re-entrancy) lives here so
 * both automations inherit it — it is covered by the ported
 * `auto-conflict-resolve-manager.test.ts` suite.
 *
 * The base does NOT own the per-attempt accounting (increment / cooldown /
 * exhaustion / WS envelope) — that is genuinely automation-specific (the
 * conflict manager awaits a structured outcome; CI fix counts one attempt per
 * dispatched turn and re-arms post-turn). Subclasses do their accounting against
 * the shared `RemediationState` using the small protected helpers below.
 */

import type { SessionRunnerInterface } from "./session-runner.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";

export type RemediationStatus = "idle" | "running" | "deferred" | "exhausted";

/**
 * Per-session state shared by every remediation automation. The fields the
 * conflict manager grew (deferred dedup, pendingReset) are kept here so CI fix
 * can adopt them — they are inert for an automation that never sets them.
 */
export interface RemediationState {
  /** Reset when head SHA changes or `resetForUserActivity` fires. */
  attemptCount: number;
  lastHeadSha: string;
  status: RemediationStatus;
  /** Last failure / defer reason — surfaced in the exhausted banner. */
  lastError?: string;
  /** Epoch ms; the next eligible attempt time after a cooldown. */
  nextEligibleAt?: number;
  /**
   * Set by `resetForUserActivity` while an attempt is in flight; applied at the
   * end of the subclass's terminal write so the in-flight attempt's terminal
   * status doesn't overwrite the reset the user just earned.
   */
  pendingReset?: boolean;
  /** Dedup tracker for back-to-back deferred WS emits (conflict manager). */
  lastEmittedDeferred?: string;
  /**
   * Epoch ms; a "settle window" opened after an attempt PUSHED (head SHA will
   * change). While set and in the future, a head-SHA change is treated as OUR
   * own push landing rather than fresh external code, so step 6 does NOT reset
   * the attempt budget — the upstream verdict for the just-pushed head is
   * likely the stale pre-recompute value and must not re-trigger an attempt.
   * Paired with `nextEligibleAt` (set to the same instant) so the cooldown gate
   * holds the re-fire until the window elapses. Inert unless a subclass sets it
   * (the conflict manager arms it on a successful force-push). See docs/146.
   */
  settleUntil?: number;
  /**
   * Head SHA first observed while a post-push settle window was open. For
   * auto-resolve-conflicts, this is the branch tip ShipIt just produced by
   * rebasing and force-pushing. A `conflicting` verdict for that same head and
   * same base is stale: a head that contains the base cannot still conflict
   * with it. Keep suppressing until the head changes again, the base moves, or
   * GitHub reports a resolved/non-fire signal.
   */
  postPushSettledHeadSha?: string;
  /** Base version paired with `postPushSettledHeadSha`, when the signal has it. */
  postPushSettledBaseSha?: string;
}

/** Trigger classification of a poll signal. */
export type SignalKind = "fire" | "resolved" | "ignore";

export interface RemediationManagerConfig {
  /** Short label for logs (e.g. "auto-resolve", "auto-fix"). */
  name: string;
  /** Hard cap on work-doing attempts per session per head SHA. */
  maxAttempts: number;
  /** Re-broadcast the session's PR snapshot over SSE. */
  onChange: (sessionId: string) => void;
  /** Resolve the per-session runner for the pre-attempt gate. */
  getRunner: (sessionId: string) => SessionRunnerInterface | undefined;
  /** Read the global enable setting at decision time (not mirrored per-session). */
  isGlobalEnabled: () => boolean;
  /** Injectable clock so cooldown logic is testable. */
  now: () => number;
  /**
   * docs/169 Workstream C — cross-automation arbiter. When set, the base
   * consults it as a stale-signal guard (drop a transition whose head SHA was
   * already acted on) and as a mutual-exclusion gate (defer while another
   * automation holds a claim for this session). Optional — absent in minimal
   * setups.
   */
  arbiter?: RemediationArbiter;
}

export abstract class AutoRemediationManager<TSignal> {
  /** sessionId → state. */
  protected states = new Map<string, RemediationState>();
  protected readonly cfg: RemediationManagerConfig;

  constructor(cfg: RemediationManagerConfig) {
    this.cfg = cfg;
  }

  // ---- Shared read/delete surface ----------------------------------------

  /** Read per-session state. Undefined when never seen / dropped on resolution. */
  get(sessionId: string): RemediationState | undefined {
    return this.states.get(sessionId);
  }

  /**
   * Drop per-session state. Calls `onDelete` so the subclass can clear its own
   * caches. Used by the poller's untrack and the terminal-PR cleanup path.
   */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.onDelete(sessionId);
  }

  /** Convenience: route an onChange through the configured broadcaster. */
  protected onChange(sessionId: string): void {
    this.cfg.onChange(sessionId);
  }

  /** Current clock reading. */
  protected now(): number {
    return this.cfg.now();
  }

  // ---- Subclass hooks -----------------------------------------------------

  /** Classify a poll signal: "fire" (act), "resolved" (settle), "ignore" (skip). */
  protected abstract classify(signal: TSignal): SignalKind;

  /**
   * Record the signal into the subclass's own caches (e.g. last-known
   * mergeable, base branch). Called for every non-ignored poll BEFORE the
   * enable check, so a first-enable poll has the right baseline.
   */
  protected abstract cacheSignal(sessionId: string, signal: TSignal): void;

  /** True when the cached signal still warrants a fire (used by `onRunnerIdle`). */
  protected abstract cachedTriggerActive(sessionId: string): boolean;

  /**
   * Rebuild a fire-able signal from the subclass caches for `onRunnerIdle`
   * (which has no fresh poll). Undefined when the cache lacks what `fireAttempt`
   * needs (e.g. no base branch recorded yet).
   */
  protected abstract rebuildSignalForIdle(sessionId: string): TSignal | undefined;

  /**
   * Optional base/version token for a signal. Subclasses that can distinguish
   * "same head, same base" from "same head, new base" override this so the
   * post-push stale-conflict guard does not suppress genuinely new conflicts.
   */
  protected signalBaseSha(_signal: TSignal): string | undefined {
    return undefined;
  }

  /**
   * Kick one attempt. Returns once the attempt has *started* (it may settle
   * asynchronously). The subclass is responsible for the terminal write (its
   * own accounting) and, when an arbiter is configured, for releasing the claim
   * on every terminal path.
   */
  protected abstract fireAttempt(sessionId: string, signal: TSignal, attempt: number): void;

  /** Clear subclass-owned caches for a session. Default no-op. */
  protected onDelete(_sessionId: string): void { /* override to clear caches */ }

  // ---- Shared state-machine drivers --------------------------------------

  /**
   * Reset the attempt budget on a user-typed input. When NOT running, clears
   * the budget immediately; when running, defers via `pendingReset` so the
   * in-flight attempt's terminal write doesn't overwrite it.
   */
  resetForUserActivity(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.status === "running") {
      state.pendingReset = true;
      return;
    }
    this.clearBudget(state);
    state.status = "idle";
    this.onChange(sessionId);
  }

  /** Clear the attempt budget + cooldown + transient error/dedup fields. */
  protected clearBudget(state: RemediationState): void {
    state.attemptCount = 0;
    delete state.nextEligibleAt;
    delete state.lastError;
    delete state.lastEmittedDeferred;
    delete state.settleUntil;
    delete state.postPushSettledHeadSha;
    delete state.postPushSettledBaseSha;
  }

  /**
   * Apply a deferred `pendingReset` at the tail of a terminal write. Returns
   * true when a reset was applied (the caller should treat the attempt's
   * terminal status as overridden).
   */
  protected applyPendingReset(sessionId: string, state: RemediationState): boolean {
    if (!state.pendingReset) return false;
    this.clearBudget(state);
    state.status = "idle";
    delete state.pendingReset;
    this.onChange(sessionId);
    return true;
  }

  /**
   * The generic poll-driven driver. Mirrors the conflict manager's documented
   * step ordering exactly (docs/146 + docs/169):
   *
   *  1. ignore signals never participate.
   *  2. cache the signal (subclass) BEFORE the enable check.
   *  3. global enable check.
   *  4. first-seen init.
   *  5. running / exhausted short-circuits.
   *  6. head-SHA-change budget reset.
   *  7. resolved signal → drop state.
   *  8. arbiter stale-signal guard (Workstream C).
   *  9. cap gate.
   * 10. cooldown gate.
   * 11. pre-attempt runner gate (the load-bearing deferred-emit-before-verify
   *     ordering).
   * 12. arbiter claim + fire.
   */
  protected async runTransition(sessionId: string, signal: TSignal, headSha: string): Promise<void> {
    // 1.
    const kind = this.classify(signal);
    if (kind === "ignore") return;

    // 2 — cache unconditionally (even while disabled) so a first-enable poll
    // has the right baseline.
    this.cacheSignal(sessionId, signal);

    // 3.
    if (!this.cfg.isGlobalEnabled()) return;

    // 4.
    let state = this.states.get(sessionId);
    if (!state) {
      state = { attemptCount: 0, lastHeadSha: headSha, status: "idle" };
      this.states.set(sessionId, state);
    }

    // 5.
    if (state.status === "running") return;
    if (state.status === "exhausted") return;

    // 6 — head-SHA-change budget reset. A new head normally means fresh
    // external code, so reset the per-head attempt budget. BUT a head change
    // inside an open settle window is almost certainly OUR own force-push
    // landing: the upstream verdict for the new head hasn't been recomputed yet
    // and is likely the stale pre-recompute value. Resetting here would zero the
    // budget AND wipe the settle cooldown, letting that stale verdict re-trigger
    // a full attempt — the success→still-conflicting→success spin (docs/146).
    // While settling, preserve the budget + cooldown so step 10 holds the
    // re-fire until the upstream recomputes.
    if (state.lastHeadSha && headSha && headSha !== state.lastHeadSha) {
      const settling = state.settleUntil !== undefined && this.now() < state.settleUntil;
      if (!settling) {
        this.clearBudget(state);
        state.status = "idle";
      } else {
        state.postPushSettledHeadSha = headSha;
        const baseSha = this.signalBaseSha(signal);
        if (baseSha) state.postPushSettledBaseSha = baseSha;
      }
    }
    state.lastHeadSha = headSha;

    // 7 — trigger no longer active: drop state so the maps shrink.
    if (kind !== "fire") {
      this.states.delete(sessionId);
      this.onDelete(sessionId);
      this.onChange(sessionId);
      return;
    }

    if (
      state.postPushSettledHeadSha !== undefined
      && headSha === state.postPushSettledHeadSha
    ) {
      const expectedBaseSha = state.postPushSettledBaseSha;
      const currentBaseSha = this.signalBaseSha(signal);
      if (!expectedBaseSha || !currentBaseSha || currentBaseSha === expectedBaseSha) {
        return;
      }
      // Same PR head against a newer base can be a genuine fresh conflict.
      this.clearBudget(state);
      state.status = "idle";
      state.lastHeadSha = headSha;
    }

    // 8 — arbiter stale-signal guard: never act on a signal whose head SHA was
    // already acted on (GitHub hasn't recomputed CI/mergeability for the new
    // code yet). Suppress until a fresh head lands.
    if (this.cfg.arbiter?.shouldSuppress(sessionId, headSha)) {
      this.defer(sessionId, state);
      return;
    }

    // 9.
    if (state.attemptCount >= this.cfg.maxAttempts) {
      state.status = "exhausted";
      this.onChange(sessionId);
      return;
    }

    // 10.
    if (state.nextEligibleAt !== undefined && this.now() < state.nextEligibleAt) return;

    // 11 — pre-attempt runner gate.
    const runner = this.cfg.getRunner(sessionId);
    if (!runner) {
      this.defer(sessionId, state);
      return;
    }
    if (runner.running) {
      // Flip to deferred + emit FIRST so a re-entrant fire from
      // `verifyRunningState`'s synchronous "idle" emit sees the right status.
      const wasDeferred = state.status === "deferred";
      state.status = "deferred";
      if (!wasDeferred) this.onChange(sessionId);
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
      // verify reset running → false and the synchronous "idle" event already
      // routed to onRunnerIdle (which, if eligible, fired). Return rather than
      // fall through to the fire below — the load-bearing contract in doc 146
      // step 11.
      return;
    }

    // 12 — claim (mutual exclusion) then fire.
    if (!this.tryClaim(sessionId, headSha)) {
      this.defer(sessionId, state);
      return;
    }
    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, signal, state.attemptCount + 1);
  }

  /**
   * Re-evaluate a `deferred` session the moment its runner goes idle, so the
   * user doesn't wait up to a full poll interval after their turn finishes.
   * Cooldown-driven retry runs through `handleTransition`, not here.
   */
  async onRunnerIdle(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (state?.status !== "deferred") return;
    if (!this.cfg.isGlobalEnabled()) return;

    if (!this.cachedTriggerActive(sessionId)) {
      // Trigger cleared while we waited — settle.
      state.status = "idle";
      this.onChange(sessionId);
      return;
    }

    if (state.attemptCount >= this.cfg.maxAttempts) {
      state.status = "exhausted";
      this.onChange(sessionId);
      return;
    }
    if (state.nextEligibleAt !== undefined && this.now() < state.nextEligibleAt) return;

    const runner = this.cfg.getRunner(sessionId);
    if (!runner) return; // stay deferred — next poll / idle retries
    if (runner.running) {
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
    }

    if (this.cfg.arbiter?.shouldSuppress(sessionId, state.lastHeadSha)) return;

    const signal = this.rebuildSignalForIdle(sessionId);
    if (!signal) return; // shouldn't happen — handleTransition seeds the cache first

    if (!this.tryClaim(sessionId, state.lastHeadSha)) return;
    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, signal, state.attemptCount + 1);
  }

  /** Mark a session deferred (idempotent emit). */
  protected defer(sessionId: string, state: RemediationState): void {
    if (state.status !== "deferred") {
      state.status = "deferred";
      this.onChange(sessionId);
    }
  }

  // ---- Arbiter integration (Workstream C) --------------------------------

  /** Claim the per-session arbiter slot for an attempt. True ⇒ proceed. */
  protected tryClaim(sessionId: string, headSha: string): boolean {
    if (!this.cfg.arbiter) return true;
    return this.cfg.arbiter.claim(sessionId, headSha, this.cfg.name);
  }

  /**
   * Release the arbiter claim. `pushed` records whether the attempt force-pushed
   * / pushed (so the arbiter suppresses ALL automations until a fresh head SHA
   * is observed). Subclasses call this on EVERY terminal path.
   */
  protected releaseClaim(sessionId: string, opts: { pushed: boolean }): void {
    this.cfg.arbiter?.release(sessionId, this.cfg.name, opts);
  }
}
