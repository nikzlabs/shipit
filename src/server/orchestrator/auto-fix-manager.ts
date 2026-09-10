import type { PrStatusSummary } from "../shared/types/github-types.js";
import type { GraphQLPrNode } from "./pr-status-parser.js";
import { extractFailedCheckRuns, extractHeadSha, extractCurrentHeadOid } from "./pr-status-parser.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { getErrorMessage } from "./validation.js";
import { AutoRemediationManager } from "./auto-remediation-manager.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";
import type { TurnOutcome } from "./turn-settlement.js";

export const MAX_AUTO_FIX_ATTEMPTS = 3;
export const AUTO_FIX_COOLDOWN_MS = 2 * 60 * 1000;
export const AUTO_FIX_DEFERRED_COOLDOWN_MS = 60 * 1000;

interface FailedCheck { databaseId: number; name: string; conclusion: string; title: string }

/** "fixed" means a turn ran, not that CI passed. */
export interface AutoFixResult { outcome: "fixed" | "noop"; lastError?: string }

// Interrupted or failed turns still count: the agent already received their logs.
export function autoFixResultForOutcome(outcome: TurnOutcome): AutoFixResult {
  if (outcome.status === "dropped" || outcome.status === "steered") {
    return { outcome: "noop", lastError: `fix turn ${outcome.status}` };
  }
  return { outcome: "fixed" };
}

export type FetchAndFixCb = (
  sessionId: string,
  owner: string,
  repo: string,
  failedChecks: FailedCheck[],
) => Promise<AutoFixResult>;

interface CiSignal {
  checksState: PrStatusSummary["checks"]["state"];
  owner: string;
  repo: string;
  failedChecks: FailedCheck[];
  rollupHeadSha: string;
  currentHeadSha?: string;
}

export class AutoFixManager extends AutoRemediationManager<CiSignal> {
  private signalCache = new Map<string, CiSignal>();

  private dispatchedCheckIds = new Map<string, Set<number>>();

  private fetchAndFixCb?: FetchAndFixCb;

  constructor(
    onChange: (sessionId: string) => void,
    getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    isGlobalEnabled: () => boolean,
    fetchAndFixCb?: FetchAndFixCb,
    now: () => number = () => Date.now(),
    arbiter?: RemediationArbiter,
    isSessionEnabled?: (sessionId: string) => boolean,
    ensureRunner?: (sessionId: string) => Promise<SessionRunnerInterface | undefined>,
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
      ...(ensureRunner ? { ensureRunner } : {}),
    });
    this.fetchAndFixCb = fetchAndFixCb;
  }

  setFetchAndFixCb(cb: FetchAndFixCb | undefined): void {
    this.fetchAndFixCb = cb;
  }

  protected classify(signal: CiSignal): "fire" | "resolved" | "ignore" {
    if (signal.checksState === "failure") return "fire";
    if (signal.checksState === "success") return "resolved";
    return "ignore";
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

  protected override isStaleFire(sessionId: string, signal: CiSignal): boolean {
    // GitHub's check rollup can lag behind the branch ref after a push.
    if (
      signal.currentHeadSha &&
      signal.rollupHeadSha &&
      signal.currentHeadSha !== signal.rollupHeadSha
    ) {
      return true;
    }
    if (signal.failedChecks.length === 0) return false;
    return this.notYetDispatched(sessionId, signal.failedChecks).length === 0;
  }

  private notYetDispatched(sessionId: string, checks: FailedCheck[]): FailedCheck[] {
    const dispatched = this.dispatchedCheckIds.get(sessionId);
    if (!dispatched) return checks;
    return checks.filter((c) => !dispatched.has(c.databaseId));
  }

  private recordDispatched(sessionId: string, checks: FailedCheck[]): void {
    let set = this.dispatchedCheckIds.get(sessionId);
    if (!set) {
      set = new Set<number>();
      this.dispatchedCheckIds.set(sessionId, set);
    }
    for (const c of checks) set.add(c.databaseId);
  }

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
      const toSend = this.notYetDispatched(sessionId, signal.failedChecks);
      const result = await cb(sessionId, signal.owner, signal.repo, toSend);
      // A no-op must remain retryable; do not restore caches deleted during the await.
      if (result.outcome === "fixed" && this.states.has(sessionId)) {
        this.recordDispatched(sessionId, toSend);
      }
      this.completeTurn(sessionId, result);
    } catch (err: unknown) {
      this.completeTurn(sessionId, { outcome: "noop", lastError: getErrorMessage(err) });
    }
  }

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
      if (result.lastError !== undefined) state.lastError = result.lastError;
      state.status = "deferred";
      state.nextEligibleAt = this.now() + AUTO_FIX_DEFERRED_COOLDOWN_MS;
    }

    // Preserve the same-head retry budget; CI fixes do not arm await-fresh-signal.
    this.releaseClaim(sessionId, { pushed: false });
    this.onChange(sessionId);
    this.applyPendingReset(sessionId, state);
  }
}
