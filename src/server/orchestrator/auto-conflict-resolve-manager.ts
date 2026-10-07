import type { PrStatusSummary, PrMergeableState } from "../shared/types/github-types.js";
import type { WsAutoResolveResult } from "../shared/types.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import { residentBackgroundWork } from "./turn-admission.js";
import { getErrorMessage } from "./validation.js";
import { AutoRemediationManager, type FireOptions } from "./auto-remediation-manager.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";

export const MAX_AUTO_RESOLVE_ATTEMPTS = 3;
export const AUTO_RESOLVE_COOLDOWN_MS = 5 * 60 * 1000;
export const AUTO_RESOLVE_DEFERRED_COOLDOWN_MS = 60 * 1000;
export const AUTO_RESOLVE_SETTLE_MS = 60 * 1000;

/**
 * The one deferral reason that is not transient: a system turn cannot displace a resident
 * agent running background work, and that work can last an hour. Retrying it on the
 * ordinary deferred cooldown is an unbounded loop (nikzlabs/shipit#2751).
 */
export const AUTO_RESOLVE_DEFER_BACKGROUND_WORK = "agent_background_work";
export const AUTO_RESOLVE_BACKGROUND_WORK_COOLDOWN_MS = 15 * 60 * 1000;

export type AutoResolveResult =
  | { outcome: "success"; forcePushed: boolean; didWork: true }
  | { outcome: "error"; lastError: string; didWork: true }
  | { outcome: "deferred"; lastError?: string; didWork: false; suppressEmit?: boolean };

export type RebaseAndResolveCb = (
  sessionId: string,
  baseBranch: string,
  opts?: FireOptions,
) => Promise<AutoResolveResult>;

interface ConflictSignal {
  mergeable: PrMergeableState;
  baseBranch: string;
  baseSha?: string;
}

export class AutoConflictResolveManager extends AutoRemediationManager<ConflictSignal> {
  private lastKnownMergeable = new Map<string, "mergeable" | "conflicting">();
  private baseBranchCache = new Map<string, string>();
  /**
   * The `nextEligibleAt` an in-force background-work deferral wrote. Identity, not a flag:
   * `state.lastError` is sticky across a later reasonless deferral, so keying the idle
   * release on the reason released a cooldown that deferral had just set.
   */
  private backgroundWorkCooldown = new Map<string, number>();

  private rebaseAndResolveCb?: RebaseAndResolveCb;

  constructor(
    onChange: (sessionId: string) => void,
    getRunner: (sessionId: string) => SessionRunnerInterface | undefined,
    isGlobalEnabled: () => boolean,
    rebaseAndResolveCb?: RebaseAndResolveCb,
    now: () => number = () => Date.now(),
    arbiter?: RemediationArbiter,
    ensureRunner?: (sessionId: string) => Promise<SessionRunnerInterface | undefined>,
    automaticTurnsHeld?: (sessionId: string) => boolean,
  ) {
    super({
      name: "auto-resolve",
      maxAttempts: MAX_AUTO_RESOLVE_ATTEMPTS,
      onChange,
      getRunner,
      isGlobalEnabled,
      now,
      ...(arbiter ? { arbiter } : {}),
      ...(ensureRunner ? { ensureRunner } : {}),
      ...(automaticTurnsHeld ? { automaticTurnsHeld } : {}),
    });
    this.rebaseAndResolveCb = rebaseAndResolveCb;
  }

  setRebaseAndResolveCb(cb: RebaseAndResolveCb): void {
    this.rebaseAndResolveCb = cb;
  }

  getLastKnownMergeable(sessionId: string): "mergeable" | "conflicting" | undefined {
    return this.lastKnownMergeable.get(sessionId);
  }

  getBaseBranch(sessionId: string): string | undefined {
    return this.baseBranchCache.get(sessionId);
  }

  protected classify(signal: ConflictSignal): "fire" | "resolved" | "ignore" {
    if (signal.mergeable === "unknown") return "ignore";
    return signal.mergeable === "conflicting" ? "fire" : "resolved";
  }

  protected cacheSignal(sessionId: string, signal: ConflictSignal): void {
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

  protected override signalBaseSha(signal: ConflictSignal): string | undefined {
    return signal.baseSha;
  }

  protected override onDelete(sessionId: string): void {
    this.lastKnownMergeable.delete(sessionId);
    this.baseBranchCache.delete(sessionId);
    this.backgroundWorkCooldown.delete(sessionId);
  }

  /**
   * The background-work cooldown is a rate bound, not the recovery path: the moment the
   * work it waits on is gone, the retry is eligible again.
   */
  override async onRunnerIdle(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    const waiting = this.backgroundWorkCooldown.get(sessionId);
    if (state?.status === "deferred" && waiting !== undefined && state.nextEligibleAt === waiting) {
      const runner = this.cfg.getRunner(sessionId);
      if (!runner || residentBackgroundWork(runner).length === 0) {
        delete state.nextEligibleAt;
        this.backgroundWorkCooldown.delete(sessionId);
      }
    }
    await super.onRunnerIdle(sessionId);
  }

  handleTransition(
    sessionId: string,
    current: PrStatusSummary,
    baseBranch: string,
    headSha: string,
    baseSha?: string,
    opts: FireOptions = {},
  ): Promise<void> {
    const signal: ConflictSignal = {
      mergeable: current.mergeable,
      baseBranch,
      ...(baseSha ? { baseSha } : {}),
    };
    return this.runTransition(sessionId, signal, headSha, opts);
  }

  protected fireAttempt(sessionId: string, signal: ConflictSignal, attempt: number, opts: FireOptions): void {
    const baseBranch = signal.baseBranch;
    this.baseBranchCache.set(sessionId, baseBranch);
    const cb = this.rebaseAndResolveCb;
    if (!cb) {
      const state = this.states.get(sessionId);
      if (state) {
        state.status = "idle";
        this.onChange(sessionId);
      }
      this.releaseClaim(sessionId, { pushed: false });
      return;
    }

    const runner = this.cfg.getRunner(sessionId);
    runner?.emitMessage({
      type: "auto_resolve_started",
      sessionId,
      baseBranch,
      attempt,
    });

    void this.runAttempt(sessionId, baseBranch, attempt, cb, opts);
  }

  private async runAttempt(
    sessionId: string,
    baseBranch: string,
    attempt: number,
    cb: RebaseAndResolveCb,
    opts: FireOptions,
  ): Promise<void> {
    try {
      const result = await cb(sessionId, baseBranch, opts);
      this.writeBack(sessionId, result, attempt);
    } catch (err: unknown) {
      // Count unexpected errors so a failing wrapper cannot retry forever.
      this.writeBack(
        sessionId,
        { outcome: "error", lastError: getErrorMessage(err), didWork: true },
        attempt,
      );
    }
  }

  /**
   * fireAttempt announced this attempt, so the banner needs a terminator every time — a
   * deduplicated one left "Rebasing onto main…" up, with Sync disabled, on every repeat of
   * the same deferral. Only a flow that ended the banner itself (`rebase_complete`) opts out.
   */
  private emitResult(
    sessionId: string,
    result: AutoResolveResult,
    fields: Omit<WsAutoResolveResult, "type" | "sessionId">,
  ): void {
    if (result.outcome === "deferred" && result.suppressEmit === true) return;
    this.cfg.getRunner(sessionId)?.emitMessage({ type: "auto_resolve_result", sessionId, ...fields });
  }

  private writeBack(sessionId: string, result: AutoResolveResult, attempt: number): void {
    const state = this.states.get(sessionId);
    if (!state) {
      // Even after state deletion, a push must block reuse of the stale verdict.
      this.releaseClaim(sessionId, {
        pushed: result.outcome === "success" && result.forcePushed,
      });
      this.emitResult(sessionId, result, { outcome: result.outcome, attempt });
      return;
    }

    let emitOutcome: "success" | "exhausted" | "deferred" | "error" = result.outcome;
    let emitForcePushed: boolean | undefined;
    let emitLastError: string | undefined;
    let pushed = false;

    // Every branch below overwrites nextEligibleAt, so no earlier marker survives this one.
    this.backgroundWorkCooldown.delete(sessionId);

    if (result.outcome === "success") {
      state.attemptCount++;
      if (result.forcePushed) {
        state.status = "idle";
        delete state.lastError;
        // GitHub can attach the old verdict to the new SHA; preserve budget while it settles.
        state.settleUntil = this.now() + AUTO_RESOLVE_SETTLE_MS;
        state.nextEligibleAt = state.settleUntil;
        emitForcePushed = true;
        pushed = true;
      } else {
        state.lastError = "force_push_failed";
        if (state.attemptCount >= MAX_AUTO_RESOLVE_ATTEMPTS) {
          state.status = "exhausted";
          emitOutcome = "exhausted";
          emitLastError = state.lastError;
        } else {
          state.status = "idle";
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
      if (result.lastError !== undefined) state.lastError = result.lastError;
      state.status = "deferred";
      const persistent = result.lastError === AUTO_RESOLVE_DEFER_BACKGROUND_WORK;
      state.nextEligibleAt = this.now() + (
        persistent ? AUTO_RESOLVE_BACKGROUND_WORK_COOLDOWN_MS : AUTO_RESOLVE_DEFERRED_COOLDOWN_MS
      );
      if (persistent) this.backgroundWorkCooldown.set(sessionId, state.nextEligibleAt);
      emitLastError = result.lastError;
    }

    this.releaseClaim(sessionId, { pushed });

    this.onChange(sessionId);

    this.emitResult(sessionId, result, {
      outcome: emitOutcome,
      attempt,
      ...(emitForcePushed !== undefined ? { forcePushed: emitForcePushed } : {}),
      ...(emitLastError !== undefined ? { lastError: emitLastError } : {}),
    });

    // User activity resets the budget even if this attempt exhausted it.
    this.applyPendingReset(sessionId, state);
  }
}
