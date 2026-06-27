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
import { extractFailedCheckRuns, extractHeadSha, extractCurrentHeadOid } from "./pr-status-parser.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getErrorMessage } from "./validation.js";
import { AutoRemediationManager } from "./auto-remediation-manager.js";
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
  /**
   * The commit the failed `statusCheckRollup` belongs to (`commits(last: 1)`).
   * This is the SHA the failed checks ran against — it LAGS the branch ref's
   * true tip during the consistency window after a push.
   */
  rollupHeadSha: string;
  /**
   * The PR branch ref's current tip (`headRefOid`). When this disagrees with
   * `rollupHeadSha`, the failure verdict is for a superseded commit and must not
   * be surfaced (defect A — SHI-62). Undefined when GitHub didn't return the
   * field, in which case the superseded guard is inert.
   */
  currentHeadSha?: string;
}

export class AutoFixManager extends AutoRemediationManager<CiSignal> {
  /** sessionId → last fire-able signal, for `onRunnerIdle` re-fires. */
  private signalCache = new Map<string, CiSignal>();

  /**
   * sessionId → failed check-run databaseIds already dispatched to the agent.
   * Each failed run is sent at most once. After a retrigger push (a new commit,
   * an empty retrigger commit, a manual re-run) GitHub keeps reporting the
   * PREVIOUS run's failure for a beat — same head, same check-run IDs — before
   * the new head's checks register. Without this, the loop re-fired CI-fix with
   * the SAME stale logs the agent already saw (and, in the reported case,
   * already judged flaky). A genuinely fresh run always carries new databaseIds,
   * so it is filtered down to only the not-yet-sent runs and fires with those.
   * Cleared on session delete and when CI goes green (the base drops state →
   * `onDelete`).
   */
  private dispatchedCheckIds = new Map<string, Set<number>>();

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
    this.dispatchedCheckIds.delete(sessionId);
  }

  /**
   * Decide whether a "fire" signal is stale and must be skipped. Two distinct
   * defects, both observed in production (SHI-62, PR #1690):
   *
   * (A) **Superseded run.** The failed `statusCheckRollup` belongs to a commit
   *     (`rollupHeadSha`) that is no longer the branch's current tip
   *     (`currentHeadSha` / `headRefOid`). GitHub's `commits(last: 1)` lags
   *     `headRefOid` in the window after a retrigger push, so a failure on the
   *     OLD commit keeps being reported even though the head has already moved on
   *     to a newer (queued/passing) run. A head-SHA-currency mismatch is stale by
   *     definition — drop it. (The original dedup missed this because it assumed
   *     the lagging head SHA was still the *current* one; it isn't — only the
   *     rollup lags, the ref tip is already ahead.)
   *
   * (B) **Nothing new to send.** Every failing run in this signal has already
   *     been dispatched. We compare against the not-yet-dispatched set rather
   *     than `Array.every(dispatched)` so a PARTIAL re-fire — one already-sent
   *     run bundled with a genuinely new sibling — is NOT treated as fresh-in-
   *     full: the fire proceeds (the new run IS fresh) but `runAttempt` filters
   *     the payload down to the new run only, so the already-seen log is not
   *     re-injected. When the filtered set is empty, the whole fire is stale.
   *
   * Empty `failedChecks` (legacy status contexts / no rollup) can't be deduped by
   * databaseId, so they fall back to the budget/cooldown gating.
   */
  protected override isStaleFire(sessionId: string, signal: CiSignal): boolean {
    // (A) superseded run — the rollup commit is behind the ref's current tip.
    if (
      signal.currentHeadSha &&
      signal.rollupHeadSha &&
      signal.currentHeadSha !== signal.rollupHeadSha
    ) {
      return true;
    }
    // (B) nothing new to send.
    if (signal.failedChecks.length === 0) return false;
    return this.notYetDispatched(sessionId, signal.failedChecks).length === 0;
  }

  /**
   * The subset of `checks` whose databaseId hasn't been dispatched to the agent
   * yet. Used both to gate a fire (empty ⇒ stale) and to trim the payload a fire
   * actually sends, so a partial re-fire never re-includes an already-seen log.
   */
  private notYetDispatched(sessionId: string, checks: FailedCheck[]): FailedCheck[] {
    const dispatched = this.dispatchedCheckIds.get(sessionId);
    if (!dispatched) return checks;
    return checks.filter((c) => !dispatched.has(c.databaseId));
  }

  /** Record the check runs a just-fired attempt sent to the agent. */
  private recordDispatched(sessionId: string, checks: FailedCheck[]): void {
    let set = this.dispatchedCheckIds.get(sessionId);
    if (!set) {
      set = new Set<number>();
      this.dispatchedCheckIds.set(sessionId, set);
    }
    for (const c of checks) set.add(c.databaseId);
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
    const rollupHeadSha = extractHeadSha(prNode) ?? "";
    const currentHeadSha = extractCurrentHeadOid(prNode);
    const signal: CiSignal = {
      checksState: current.checks.state,
      owner,
      repo,
      failedChecks: current.checks.state === "failure" ? extractFailedCheckRuns(prNode) : [],
      rollupHeadSha,
      ...(currentHeadSha !== undefined ? { currentHeadSha } : {}),
    };
    return this.runTransition(sessionId, signal, rollupHeadSha);
  }

  // A manual "Fix CI" no longer engages this state machine. It's a plain
  // user-initiated agent turn (`triggerCIFix` dispatches it directly); the
  // auto-fix `running` status — and the "Auto-fixing (attempt N/3)…" card line
  // it drives — is reserved for the automatic loop below. (docs/169 follow-up)

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
      // Defect B — send logs ONLY for runs we haven't already dispatched, so a
      // partial re-fire (a new sibling failure bundled with an already-sent one)
      // re-injects just the new run's log, not the one the agent already saw.
      // `isStaleFire` guarantees this is non-empty for a non-empty input (an
      // all-already-sent set is suppressed upstream); an empty input (legacy
      // status contexts) passes straight through.
      const toSend = this.notYetDispatched(sessionId, signal.failedChecks);
      const result = await cb(sessionId, signal.owner, signal.repo, toSend);
      // Record the dispatched runs only when a fix turn actually ran (the agent
      // saw these logs). A "noop" sent nothing — leave them un-recorded so the
      // next eligible poll retries.
      if (result.outcome === "fixed") this.recordDispatched(sessionId, toSend);
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
