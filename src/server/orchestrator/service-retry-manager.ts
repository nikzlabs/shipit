/**
 * ServiceRetryManager — owns the retry timers, backoff schedule, and OOM
 * auto-retry budget for compose services.
 *
 * Extracted from `service-manager.ts` so the retry/OOM bookkeeping has a
 * single home and the manager can stay focused on compose CLI invocation
 * and lifecycle. The manager delegates four kinds of events to this class:
 *
 *   - `scheduleRetryWhileInstalling(name, exitCode)` — a `preview: auto`
 *     service exited non-zero while `agent.install` is in flight.
 *   - `scheduleOomRetry(name)` — a `preview: auto` service exited with
 *     code 137 (OOM-killed).
 *   - `armOomStableResetIfNeeded(name)` — the service has recovered to
 *     `running` after at least one OOM retry; arm a stable-uptime timer
 *     so the OOM budget resets if it stays healthy long enough.
 *   - `cancelOomStableTimer(name)` — the service left `running`; cancel
 *     any armed stable-uptime timer.
 *
 * The manager owns the actual restart action (it has the compose CLI
 * wiring) and supplies it as the `runRetryNow` callback. The retry
 * manager itself never touches Docker.
 */

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_OOM_AUTO_RETRIES = 3;
const OOM_STABLE_RESET_MS = 60_000;

export interface ServiceRetryManagerOptions {
  sessionId: string;
  /** Returns `true` once the parent `ServiceManager.stop()` has been called. */
  isDisposed: () => boolean;
  /** Update a service's status (delegates to the manager). */
  updateServiceStatus: (name: string, status: "starting" | "error", error?: string) => void;
  /**
   * Run a single restart attempt for the named service. Resolves on success;
   * on failure, the manager is expected to either schedule another retry
   * (install window) or latch to `error`.
   */
  runRetryNow: (name: string) => Promise<void>;
}

export class ServiceRetryManager {
  private readonly sessionId: string;
  private readonly isDisposed: () => boolean;
  private readonly updateServiceStatus: ServiceRetryManagerOptions["updateServiceStatus"];
  private readonly runRetryNow: (name: string) => Promise<void>;

  // --- Install-window retry state ---
  /** Per-service backoff timer for retry-while-installing. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-service retry attempt counter (drives exponential backoff). */
  private retryAttempts = new Map<string, number>();

  // --- OOM auto-retry state ---
  /**
   * Per-service OOM attempt counter — separate from `retryAttempts` (which
   * tracks install-window retries). Counts consecutive OOM-killed exits
   * (code 137) for a `preview: auto` service. Reset when:
   *   - The service runs for `OOM_STABLE_RESET_MS` without OOMing again
   *     (the typical "one-off pressure spike" case).
   *   - The service is explicitly stopped or restarted by the user.
   *   - The manager is reconciled / disposed.
   * NOT reset on every momentary `running` poll — a service that flaps in
   * and out of `running` while OOMing every few seconds must NOT loop
   * forever; the cap forces the user to intervene after MAX retries.
   */
  private oomRetryAttempts = new Map<string, number>();
  /**
   * Per-service stable-uptime timers. When a service comes up `running`
   * after at least one OOM-retry, we arm a timer to clear the OOM counter
   * if it stays running long enough. The timer is cancelled if the
   * service leaves `running` before it fires.
   */
  private oomStableTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ServiceRetryManagerOptions) {
    this.sessionId = opts.sessionId;
    this.isDisposed = opts.isDisposed;
    this.updateServiceStatus = opts.updateServiceStatus;
    this.runRetryNow = opts.runRetryNow;
  }

  /**
   * Schedule a retry for a service that exited non-zero while
   * `agent.install` is still in flight. Uses exponential backoff capped at
   * 10s. The service is held in `starting` state (not `error`) so the user
   * sees a benign "still coming up" rather than a failure.
   */
  scheduleRetryWhileInstalling(name: string, exitCode: number): void {
    if (this.isDisposed()) return;
    // If a retry is already pending, leave it in place.
    if (this.retryTimers.has(name)) return;

    const attempt = this.retryAttempts.get(name) ?? 0;
    const delayIdx = Math.min(attempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[delayIdx];
    this.retryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} exited ${exitCode} while install in progress — retry #${attempt + 1} in ${delay}ms`,
    );

    // Reflect "still coming up" to the UI rather than `error`.
    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  /**
   * Schedule an OOM-recovery retry for a `preview: auto` service that
   * just exited with code 137. Mirrors `scheduleRetryWhileInstalling` but
   * is bounded by `MAX_OOM_AUTO_RETRIES` — after that many consecutive
   * OOMs without a stable-uptime window in between, we latch to `error`
   * so the user can investigate.
   */
  scheduleOomRetry(name: string): void {
    if (this.isDisposed()) return;
    // If a retry is already pending, leave it in place.
    if (this.retryTimers.has(name)) return;

    const attempt = this.oomRetryAttempts.get(name) ?? 0;
    if (attempt >= MAX_OOM_AUTO_RETRIES) {
      // Exhausted — latch to error with a message that explicitly names
      // the retry budget so the user knows we already tried (and that
      // Rescue session won't help here, only fixing the underlying memory
      // pressure will).
      //
      // We intentionally do NOT delete the counter here: the next periodic
      // pollStatus tick will see the service still in `exited`/`dead` state
      // and re-enter this method. Leaving the counter at MAX_OOM_AUTO_RETRIES
      // keeps the gate closed so we don't kick off a fresh retry loop. The
      // counter is reset only by an explicit user action (startService /
      // restartService) or by manager-wide cleanup (cancelAll).
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

    // Reflect "still coming up" to the UI rather than `error`. The
    // PreviewFrame banner / service dot stay yellow during the retry
    // window instead of going red.
    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  /**
   * Arm a stable-uptime timer for a service that has reached `running`
   * after at least one OOM auto-retry. If the service stays running for
   * `OOM_STABLE_RESET_MS` the OOM counter resets; if it leaves `running`
   * first, the timer is cancelled by the next exited-state poll.
   */
  armOomStableResetIfNeeded(name: string): void {
    if (!this.oomRetryAttempts.has(name)) return;
    if (this.oomStableTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.oomStableTimers.delete(name);
      this.oomRetryAttempts.delete(name);
    }, OOM_STABLE_RESET_MS);
    this.oomStableTimers.set(name, timer);
  }

  /** Cancel the stable-uptime timer for a service (when it leaves `running`). */
  cancelOomStableTimer(name: string): void {
    const timer = this.oomStableTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.oomStableTimers.delete(name);
    }
  }

  /** Clear any retry state for a service that has recovered or stopped cleanly. */
  clearRetryState(name: string): void {
    const timer = this.retryTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(name);
    }
    this.retryAttempts.delete(name);
  }

  /**
   * Drop the OOM auto-retry budget for a single service. Called from
   * explicit user actions (`startService`, `restartService`) — if the user
   * says "try again," respect that and give the service a fresh budget.
   */
  resetOomBudget(name: string): void {
    this.cancelOomStableTimer(name);
    this.oomRetryAttempts.delete(name);
  }

  /**
   * Drop the OOM auto-retry budget for a service that exited cleanly
   * (exit code 0). Distinct from `resetOomBudget` only by intent — both
   * paths clear the counter without touching the stable-uptime timer
   * (the caller has already cancelled it).
   */
  clearOomBudget(name: string): void {
    this.oomRetryAttempts.delete(name);
  }

  /** Cancel all pending retries — used during `stop()` / `reconcile()`. */
  cancelAll(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    for (const timer of this.oomStableTimers.values()) clearTimeout(timer);
    this.oomStableTimers.clear();
    this.oomRetryAttempts.clear();
  }

  /**
   * Called when `setInstallRunning(false)` is invoked. Cancels pending
   * install-window backoff timers and returns the union of:
   *   - services that had a pending retry timer (we just cancelled them)
   *   - services in `errorServices` (passed in by the manager — typically
   *     every `preview: auto` service currently in `error`)
   *
   * The manager then runs one explicit restart for each name in the
   * returned set, so a service that latched to `error` before the retry
   * path was reached (e.g. stack-level start failure) still gets one
   * post-install try.
   */
  collectPostInstallRetryTargets(errorServices: Iterable<string>): Set<string> {
    const targets = new Set<string>();

    // Cancel pending backoff timers — caller will restart immediately.
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

  /**
   * After `collectPostInstallRetryTargets()` returns its target set, the
   * caller invokes this once per target to clear the per-service install
   * retry counter so a fresh post-install run starts from attempt 0.
   */
  resetInstallAttempts(name: string): void {
    this.retryAttempts.delete(name);
  }

}
