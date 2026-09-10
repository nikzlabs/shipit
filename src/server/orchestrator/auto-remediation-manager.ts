import type { SessionRunnerInterface } from "./session-runner.js";
import type { RemediationArbiter } from "./auto-remediation-arbiter.js";

export type RemediationStatus = "idle" | "running" | "deferred" | "exhausted";

export interface RemediationState {
  attemptCount: number;
  lastHeadSha: string;
  status: RemediationStatus;
  lastError?: string;
  nextEligibleAt?: number;
  pendingReset?: boolean;
  lastEmittedDeferred?: string;
  settleUntil?: number;
  postPushSettledHeadSha?: string;
  postPushSettledBaseSha?: string;
}

export type SignalKind = "fire" | "resolved" | "ignore";

export interface RemediationManagerConfig {
  name: string;
  maxAttempts: number;
  onChange: (sessionId: string) => void;
  getRunner: (sessionId: string) => SessionRunnerInterface | undefined;
  ensureRunner?: (sessionId: string) => Promise<SessionRunnerInterface | undefined>;
  isGlobalEnabled: () => boolean;
  isSessionEnabled?: (sessionId: string) => boolean;
  now: () => number;
  arbiter?: RemediationArbiter;
}

export abstract class AutoRemediationManager<TSignal> {
  protected states = new Map<string, RemediationState>();
  protected readonly cfg: RemediationManagerConfig;

  constructor(cfg: RemediationManagerConfig) {
    this.cfg = cfg;
  }

  get(sessionId: string): RemediationState | undefined {
    return this.states.get(sessionId);
  }

  isEnabledFor(sessionId: string): boolean {
    if (!this.cfg.isGlobalEnabled()) return false;
    if (this.cfg.isSessionEnabled && !this.cfg.isSessionEnabled(sessionId)) return false;
    return true;
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.onDelete(sessionId);
  }

  protected onChange(sessionId: string): void {
    this.cfg.onChange(sessionId);
  }

  protected now(): number {
    return this.cfg.now();
  }

  protected abstract classify(signal: TSignal): SignalKind;

  protected abstract cacheSignal(sessionId: string, signal: TSignal): void;

  protected abstract cachedTriggerActive(sessionId: string): boolean;

  protected abstract rebuildSignalForIdle(sessionId: string): TSignal | undefined;

  protected signalBaseSha(_signal: TSignal): string | undefined {
    return undefined;
  }

  /** Subclasses must release the claim on every terminal path. */
  protected abstract fireAttempt(sessionId: string, signal: TSignal, attempt: number): void;

  protected onDelete(_sessionId: string): void { /* override to clear caches */ }

  protected isStaleFire(_sessionId: string, _signal: TSignal): boolean {
    return false;
  }

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

  protected clearBudget(state: RemediationState): void {
    state.attemptCount = 0;
    delete state.nextEligibleAt;
    delete state.lastError;
    delete state.lastEmittedDeferred;
    delete state.settleUntil;
    delete state.postPushSettledHeadSha;
    delete state.postPushSettledBaseSha;
  }

  protected applyPendingReset(sessionId: string, state: RemediationState): boolean {
    if (!state.pendingReset) return false;
    this.clearBudget(state);
    state.status = "idle";
    delete state.pendingReset;
    this.onChange(sessionId);
    return true;
  }

  protected async runTransition(sessionId: string, signal: TSignal, headSha: string): Promise<void> {
    const kind = this.classify(signal);
    if (kind === "ignore") return;

    if (kind === "fire" && this.isStaleFire(sessionId, signal)) return;

    // Cache while disabled so re-enabling uses the latest signal.
    this.cacheSignal(sessionId, signal);

    if (!this.cfg.isGlobalEnabled()) return;
    if (this.cfg.isSessionEnabled && !this.cfg.isSessionEnabled(sessionId)) return;

    let state = this.states.get(sessionId);
    if (!state) {
      state = { attemptCount: 0, lastHeadSha: headSha, status: "idle" };
      this.states.set(sessionId, state);
    }

    // Clear resolved state before the running/exhausted checks. Let an active turn finish.
    if (kind !== "fire") {
      this.states.delete(sessionId);
      this.onDelete(sessionId);
      this.onChange(sessionId);
      return;
    }

    if (state.status === "running") return;
    if (state.status === "exhausted") return;

    // Our own push must not reset the budget while GitHub still serves a stale verdict.
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

    if (
      state.postPushSettledHeadSha !== undefined
      && headSha === state.postPushSettledHeadSha
    ) {
      const expectedBaseSha = state.postPushSettledBaseSha;
      const currentBaseSha = this.signalBaseSha(signal);
      if (!expectedBaseSha || !currentBaseSha || currentBaseSha === expectedBaseSha) {
        return;
      }
      this.clearBudget(state);
      state.status = "idle";
      state.lastHeadSha = headSha;
    }

    if (this.cfg.arbiter?.shouldSuppress(sessionId, headSha)) {
      this.defer(sessionId, state);
      return;
    }

    if (state.attemptCount >= this.cfg.maxAttempts) {
      state.status = "exhausted";
      this.onChange(sessionId);
      return;
    }

    if (state.nextEligibleAt !== undefined && this.now() < state.nextEligibleAt) return;

    let runner = this.cfg.getRunner(sessionId);
    if (!runner && this.cfg.ensureRunner) runner = await this.cfg.ensureRunner(sessionId);
    if (!runner) {
      this.defer(sessionId, state);
      return;
    }
    if (runner.running) {
      // verifyRunningState can synchronously emit idle and re-enter; set deferred first.
      const wasDeferred = state.status === "deferred";
      state.status = "deferred";
      if (!wasDeferred) this.onChange(sessionId);
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
      // The idle handler may already have fired the attempt.
      return;
    }

    if (!this.tryClaim(sessionId, headSha)) {
      this.defer(sessionId, state);
      return;
    }
    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, signal, state.attemptCount + 1);
  }

  async onRunnerIdle(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (state?.status !== "deferred") return;
    if (!this.cfg.isGlobalEnabled()) return;
    if (this.cfg.isSessionEnabled && !this.cfg.isSessionEnabled(sessionId)) return;

    if (!this.cachedTriggerActive(sessionId)) {
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

    let runner = this.cfg.getRunner(sessionId);
    if (!runner && this.cfg.ensureRunner) runner = await this.cfg.ensureRunner(sessionId);
    if (!runner) return;
    if (runner.running) {
      const stillRunning = await runner.verifyRunningState();
      if (stillRunning) return;
    }

    if (this.cfg.arbiter?.shouldSuppress(sessionId, state.lastHeadSha)) return;

    const signal = this.rebuildSignalForIdle(sessionId);
    if (!signal) return;
    if (this.isStaleFire(sessionId, signal)) return;

    if (!this.tryClaim(sessionId, state.lastHeadSha)) return;
    state.status = "running";
    this.onChange(sessionId);
    this.fireAttempt(sessionId, signal, state.attemptCount + 1);
  }

  protected defer(sessionId: string, state: RemediationState): void {
    if (state.status !== "deferred") {
      state.status = "deferred";
      this.onChange(sessionId);
    }
  }

  protected tryClaim(sessionId: string, headSha: string): boolean {
    if (!this.cfg.arbiter) return true;
    return this.cfg.arbiter.claim(sessionId, headSha, this.cfg.name);
  }

  protected releaseClaim(sessionId: string, opts: { pushed: boolean }): void {
    this.cfg.arbiter?.release(sessionId, this.cfg.name, opts);
  }
}
