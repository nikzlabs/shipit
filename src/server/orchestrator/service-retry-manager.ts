const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_OOM_AUTO_RETRIES = 3;
const OOM_STABLE_RESET_MS = 60_000;
const MAX_POST_GATE_RETRIES = 5;
// A running container may still be installing dependencies.
const POST_GATE_STABLE_MS = 60_000;

export interface ServiceRetryManagerOptions {
  sessionId: string;
  isDisposed: () => boolean;
  updateServiceStatus: (name: string, status: "starting" | "error", error?: string) => void;
  runRetryNow: (name: string) => Promise<void>;
}

export class ServiceRetryManager {
  private readonly sessionId: string;
  private readonly isDisposed: () => boolean;
  private readonly updateServiceStatus: ServiceRetryManagerOptions["updateServiceStatus"];
  private readonly runRetryNow: (name: string) => Promise<void>;

  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryAttempts = new Map<string, number>();
  private oomRetryAttempts = new Map<string, number>();
  private oomStableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private postGateRetryAttempts = new Map<string, number>();
  private postGateStableTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ServiceRetryManagerOptions) {
    this.sessionId = opts.sessionId;
    this.isDisposed = opts.isDisposed;
    this.updateServiceStatus = opts.updateServiceStatus;
    this.runRetryNow = opts.runRetryNow;
  }

  scheduleRetryWhileInstalling(name: string, exitCode: number): void {
    if (this.isDisposed()) return;
    if (this.retryTimers.has(name)) return;

    const attempt = this.retryAttempts.get(name) ?? 0;
    const delayIdx = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[delayIdx];
    this.retryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} exited ${exitCode} while install in progress — retry #${attempt + 1} in ${delay}ms`,
    );

    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  // The caller must confirm State.OOMKilled; exit 137 alone is insufficient.
  scheduleOomRetry(name: string): void {
    if (this.isDisposed()) return;
    if (this.retryTimers.has(name)) return;

    const attempt = this.oomRetryAttempts.get(name) ?? 0;
    if (attempt >= MAX_OOM_AUTO_RETRIES) {
      // Keep the exhausted counter so repeated polls cannot restart the loop.
      this.updateServiceStatus(
        name,
        "error",
        `OOMKilled (exit 137) — gave up after ${MAX_OOM_AUTO_RETRIES} auto-retries; increase the service's memory limit or close other sessions to free host memory`,
      );
      return;
    }

    const delayIdx = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[delayIdx];
    this.oomRetryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} OOMKilled — retry #${attempt + 1}/${MAX_OOM_AUTO_RETRIES} in ${delay}ms`,
    );

    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  schedulePostGateRetry(name: string): boolean {
    if (this.isDisposed()) return true;
    if (this.retryTimers.has(name)) return true;

    const attempt = this.postGateRetryAttempts.get(name) ?? 0;
    if (attempt >= MAX_POST_GATE_RETRIES) {
      this.postGateRetryAttempts.delete(name);
      console.log(
        `[compose:${this.sessionId}] ${name} still crashing after ${MAX_POST_GATE_RETRIES} post-install retries — marking error`,
      );
      return false;
    }

    const delayIdx = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[delayIdx];
    this.postGateRetryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} crashed just after install gate opened — retry #${attempt + 1}/${MAX_POST_GATE_RETRIES} in ${delay}ms`,
    );

    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
    return true;
  }

  clearPostGateState(name: string): void {
    this.postGateRetryAttempts.delete(name);
  }

  armPostGateStableClear(name: string, onStable: () => void): void {
    if (this.postGateStableTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.postGateStableTimers.delete(name);
      this.postGateRetryAttempts.delete(name);
      onStable();
    }, POST_GATE_STABLE_MS);
    this.postGateStableTimers.set(name, timer);
  }

  cancelPostGateStableTimer(name: string): void {
    const timer = this.postGateStableTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.postGateStableTimers.delete(name);
    }
  }

  // Brief returns to running must not reset the OOM budget.
  armOomStableResetIfNeeded(name: string): void {
    if (!this.oomRetryAttempts.has(name)) return;
    if (this.oomStableTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.oomStableTimers.delete(name);
      this.oomRetryAttempts.delete(name);
    }, OOM_STABLE_RESET_MS);
    this.oomStableTimers.set(name, timer);
  }

  cancelOomStableTimer(name: string): void {
    const timer = this.oomStableTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.oomStableTimers.delete(name);
    }
  }

  clearRetryState(name: string): void {
    const timer = this.retryTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(name);
    }
    this.retryAttempts.delete(name);
  }

  resetOomBudget(name: string): void {
    this.cancelOomStableTimer(name);
    this.oomRetryAttempts.delete(name);
  }

  clearOomBudget(name: string): void {
    this.oomRetryAttempts.delete(name);
  }

  cancelAll(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    for (const timer of this.oomStableTimers.values()) clearTimeout(timer);
    this.oomStableTimers.clear();
    this.oomRetryAttempts.clear();
    for (const timer of this.postGateStableTimers.values()) clearTimeout(timer);
    this.postGateStableTimers.clear();
    this.postGateRetryAttempts.clear();
  }

  collectPostInstallRetryTargets(errorServices: Iterable<string>): Set<string> {
    const targets = new Set<string>();

    // The caller restarts these immediately after install completes.
    for (const [name, timer] of this.retryTimers) {
      clearTimeout(timer);
      targets.add(name);
    }
    this.retryTimers.clear();

    for (const name of errorServices) {
      targets.add(name);
    }

    return targets;
  }

  resetInstallAttempts(name: string): void {
    this.retryAttempts.delete(name);
  }

}
