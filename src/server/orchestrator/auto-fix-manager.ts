/**
 * AutoFixManager — auto-fix-CI specialization of the shared
 * `AutoRemediationManager` base. (docs/169)
 *
 * Before docs/169 this was a 127-line hand-rolled copy of the conflict
 * manager's skeleton that had drifted in three user-visible ways:
 *   1. it never re-armed within a head SHA, so the advertised 3-attempt budget
 *      was effectively a 1-attempt budget (the loop wedged in `"running"` after
 *      the first fix turn);
 *   2. it had no cooldown, no `resetForUserActivity`, and no `onRunnerIdle`
 *      re-eval; and
 *   3. it was a per-session, in-memory, lost-on-restart toggle while the
 *      conflict automation was global + persisted.
 *
 * Now it shares the base state machine and adopts all three missing
 * capabilities. The toggle is GLOBAL + persisted (the base reads
 * `isGlobalEnabled` at decision time — wired to `credentialStore.getAutoFixCi`)
 * rather than a per-session map. Accounting is "turn mode": each fired attempt
 * dispatches ONE fix turn through `runner.dispatch`, and the **post-turn**
 * `completeTurn` transition re-arms the loop (idle + cooldown) — this is the fix
 * for the wedge bug. A still-red CI then re-fires on the next poll once the
 * cooldown elapses, until the budget is spent.
 */

import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";
import { extractFailedCheckRuns, extractHeadSha } from "./pr-status-parser.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getErrorMessage } from "./validation.js";
import { AutoRemediationManager, type RemediationState } from "./auto-remediation-manager.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";

export const MAX_AUTO_FIX_ATTEMPTS = 3;
/**
 * Cooldown after a fix turn completes before the loop re-fires on a still-red
 * CI for the same head. Without it, the moment `completeTurn` re-arms the loop
 * the next poll would immediately re-fire and burn the remaining attempts in
 * seconds. Sized to let a re-run of CI register a fresh verdict.
 */
export const AUTO_FIX_COOLDOWN_MS = 2 * 60 * 1000;
/**
 * Shorter cooldown after a no-op attempt (no failed checks to fetch, no runner,
 * log fetch failed) — bounds the per-poll cost of a sticky no-op without
 * burning budget.
 */
export const AUTO_FIX_DEFERRED_COOLDOWN_MS = 60 * 1000;

interface FailedCheck { databaseId: number; name: string; conclusion: string; title: string }

/**
 * Outcome of a single auto-fix attempt, returned by the injected callback.
 * `"fixed"` ⇒ a fix turn actually ran (count it + cooldown re-arm). `"noop"` ⇒
 * couldn't even start (no logs / no runner) — defer without burning budget.
 */
export interface AutoFixResult { outcome: "fixed" | "noop"; lastError?: string }

/**
 * Callback that performs the actual fix: fetch CI logs, dispatch the fix turn
 * (a `systemTurn`), and resolve once that turn completes — so the manager can
 * do its post-turn accounting. Late-bound from the poller/app-lifecycle wiring.
 */
export type FetchAndFixCb = (
  sessionId: string,
  owner: string,
  repo: string,
  failedChecks: FailedCheck[],
) => Promise<AutoFixResult>;

/** The auto-fix poll signal: CI verdict + the repo coordinates + failed checks. */
interface CiSignal {
  checksState: PrStatusSummary["checks"]["state"];
  owner: string;
  repo: string;
  failedChecks: FailedCheck[];
}

export class AutoFixManager extends AutoRemediationManager<CiSignal> {
  /** sessionId → last fire-able signal, for `onRunnerIdle` re-fires. */
  private signalCache = new Map<string, CiSignal>();

  private fetchAndFixCb?: FetchAndFixCb;

  constructor(
    onChange: (sessionId: string) => void,
    getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    isGlobalEnabled: () => boolean,
    fetchAndFixCb?: FetchAndFixCb,
    now: () => number = () => Date.now(),
    /** docs/169 Workstream C — cross-automation arbiter (optional). */
    arbiter?: RemediationArbiter,
    /**
     * docs/186 — per-session pause gate. Returns false when auto-fix is paused
     * for the session, suppressing the loop even with the global setting on.
     */
    isSessionEnabled?: (sessionId: string) => boolean,
  ) {
    super({
      name: "auto-fix",
      maxAttempts: MAX_AUTO_FIX_ATTEMPTS,
      onChange,
      getRunner,
      isGlobalEnabled,
      now,
      ...(arbiter ? { arbiter } : {}),
      ...(isSessionEnabled ? { isSessionEnabled } : {}),
    });
    this.fetchAndFixCb = fetchAndFixCb;
  }

  /** Late-bind the fetch-and-fix callback. */
  setFetchAndFixCb(cb: FetchAndFixCb | undefined): void {
    this.fetchAndFixCb = cb;
  }

  // ---- Base hooks ---------------------------------------------------------

  protected classify(signal: CiSignal): "fire" | "resolved" | "ignore" {
    if (signal.checksState === "failure") return "fire";
    if (signal.checksState === "success") return "resolved";
    return "ignore"; // pending / none — CI hasn't given a verdict yet
  }

  protected cacheSignal(sessionId: string, signal: CiSignal): void {
    this.signalCache.set(sessionId, signal);
  }

  protected cachedTriggerActive(sessionId: string): boolean {
    return this.signalCache.get(sessionId)?.checksState === "failure";
  }

  protected rebuildSignalForIdle(sessionId: string): CiSignal | undefined {
    return this.signalCache.get(sessionId);
  }

  protected override onDelete(sessionId: string): void {
    this.signalCache.delete(sessionId);
  }

  // ---- Public entry point (poller auto-loop) ------------------------------

  /**
   * Auto-loop entry from `PrStatusPoller`. Same 5-arg signature the poller has
   * always called. Translates the summary + PR node into a `CiSignal` and runs
   * the generic base driver.
   */
  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    prNode: GraphQLPrNode,
    owner: string,
    repo: string,
  ): Promise<void> {
    const signal: CiSignal = {
      checksState: current.checks.state,
      owner,
      repo,
      failedChecks: current.checks.state === "failure" ? extractFailedCheckRuns(prNode) : [],
    };
    return this.runTransition(sessionId, signal, extractHeadSha(prNode) ?? "");
  }

  // ---- Manual one-shot fix (the "Fix CI" button) --------------------------

  /**
   * Mark a manual one-shot fix as running. Used by `triggerCIFix` (the
   * user-clicked "Fix CI" button), which dispatches its own turn rather than
   * going through the auto-loop's `fireAttempt`. Increments the attempt counter
   * and flips to `running` so the card shows progress; the next head-SHA change
   * (the fix's push) resets the state. Creates state on first use so a manual
   * fix works even with the global auto-fix toggle off.
   */
  markRunning(sessionId: string): RemediationState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { attemptCount: 0, lastHeadSha: "", status: "idle" };
      this.states.set(sessionId, state);
    }
    state.attemptCount++;
    state.status = "running";
    this.onChange(sessionId);
    return state;
  }

  // ---- Fire + terminal accounting (auto-loop) -----------------------------

  protected fireAttempt(sessionId: string, signal: CiSignal, _attempt: number): void {
    const cb = this.fetchAndFixCb;
    if (!cb) {
      const state = this.states.get(sessionId);
      if (state) {
        state.status = "idle";
        this.onChange(sessionId);
      }
      this.releaseClaim(sessionId, { pushed: false });
      return;
    }
    void this.runAttempt(sessionId, signal, cb);
  }

  private async runAttempt(sessionId: string, signal: CiSignal, cb: FetchAndFixCb): Promise<void> {
    try {
      const result = await cb(sessionId, signal.owner, signal.repo, signal.failedChecks);
      this.completeTurn(sessionId, result);
    } catch (err: unknown) {
      // A throw from the callback is almost always pre-flight (log fetch
      // failed) — defer rather than burn budget.
      this.completeTurn(sessionId, { outcome: "noop", lastError: getErrorMessage(err) });
    }
  }

  /**
   * The post-turn transition (docs/169 B3a). The single place a fired attempt's
   * `running` status becomes anything else and the only place `attemptCount` is
   * incremented for the auto-loop, plus the single arbiter-release site.
   * Re-arms the loop (idle + cooldown) so a still-red CI re-fires on the next
   * poll until the budget is spent — the fix for the 1-attempt-budget wedge.
   */
  private completeTurn(sessionId: string, result: AutoFixResult): void {
    const state = this.states.get(sessionId);
    if (!state) {
      this.releaseClaim(sessionId, { pushed: false });
      return;
    }

    if (result.outcome === "fixed") {
      state.attemptCount++;
      delete state.lastError;
      if (state.attemptCount >= MAX_AUTO_FIX_ATTEMPTS) {
        state.status = "exhausted";
      } else {
        state.status = "idle";
        state.nextEligibleAt = this.now() + AUTO_FIX_COOLDOWN_MS;
      }
    } else {
      // noop — couldn't start; defer without counting.
      if (result.lastError !== undefined) state.lastError = result.lastError;
      state.status = "deferred";
      state.nextEligibleAt = this.now() + AUTO_FIX_DEFERRED_COOLDOWN_MS;
    }

    // CI fix doesn't arm the arbiter's await-fresh-signal (the conflict
    // automation's UNKNOWN-mergeability gating covers the post-push window);
    // releasing with pushed:false preserves the same-head retry budget.
    this.releaseClaim(sessionId, { pushed: false });
    this.onChange(sessionId);
    this.applyPendingReset(sessionId, state);
  }
}
