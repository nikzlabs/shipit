/**
 * Session OOM circuit breaker.
 *
 * The destroy/recreate loop on a memory-exhausted session goes:
 *   container_started → npm install → cgroup OOM → die →
 *   handleContainerExited → runner.dispose → user/client reconnects →
 *   activateSession → runner factory → createContainerForRunner →
 *   container_started → ...
 *
 * The loop wastes host memory and disk churn, and the user just sees a
 * spinner with no actionable error. This breaker tracks OOM kills per
 * session in a sliding window — once the threshold is crossed it trips,
 * and the runner factory + standby creator refuse to make a new container
 * until the user explicitly resets it (via the "Rescue session" /
 * agent-container-restart endpoint, which represents an opt-in retry).
 *
 * Tripping is sticky: an auto-timeout would re-enter the loop just to
 * confirm the memory is still exhausted. The state is process-local —
 * an orchestrator restart clears it, which matches the operational model
 * (after a redeploy, all bets are off).
 *
 * Pure module: no Docker, no I/O. Tested in isolation. Mirrors the shape
 * of `loop-detector.ts`.
 */

/** Default window — match `loop-detector.ts` so OOM trips line up with loop alerts. */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** OOM kills within the window required to trip. */
const DEFAULT_THRESHOLD = 3;

export interface OomCircuitBreakerOpts {
  windowMs?: number;
  threshold?: number;
  /** Time source — overridable for tests. */
  now?: () => number;
}

export interface OomBreakerState {
  /** True iff future container creation should be blocked. */
  tripped: boolean;
  /** OOMs counted in the current window. */
  countInWindow: number;
  /** Most recent OOM timestamp (ms epoch), or null if no OOMs recorded. */
  lastOomAt: number | null;
  /** When the breaker tripped (ms epoch), or null if not tripped. */
  trippedAt: number | null;
  threshold: number;
  windowMs: number;
}

export interface OomRecordResult extends OomBreakerState {
  /** True only on the call that flipped the breaker from healthy to tripped. */
  justTripped: boolean;
}

export interface SessionOomCircuitBreaker {
  /**
   * Record an OOM kill for `sessionId` and return the resulting state.
   * `justTripped` is true exactly once — the call that crossed the
   * threshold — so callers can emit a "session disabled" notification
   * without duplicating it on every subsequent OOM.
   */
  recordOom(sessionId: string): OomRecordResult;

  /**
   * Immediately trip the breaker without recording an OOM. Used by the
   * loop detector as a last-resort circuit: if the same session has
   * spawned containers 3+ times in 5 min the cycle is pathological even
   * when individual exits aren't tagged as OOM (e.g. die-before-oom
   * event ordering loses the OOM signal). `justTripped` is true exactly
   * once, mirroring `recordOom`'s semantics so the caller's
   * trip-emission code path is shared.
   */
  forceTrip(sessionId: string): OomRecordResult;

  /** Whether new container creation should be refused for this session. */
  isTripped(sessionId: string): boolean;

  /** Snapshot for the diagnostics panel — never null, defaults to healthy. */
  getState(sessionId: string): OomBreakerState;

  /**
   * Clear all state for a session. Called when the user explicitly opts
   * into another attempt (e.g. "Rescue session" / agent-container-restart)
   * or bumps memory in shipit.yaml.
   */
  reset(sessionId: string): void;

  /** Drop all state for a session — called on archive / remove. */
  forget(sessionId: string): void;
}

export function createOomCircuitBreaker(opts: OomCircuitBreakerOpts = {}): SessionOomCircuitBreaker {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const now = opts.now ?? Date.now;

  const ooms = new Map<string, number[]>();
  const trippedAt = new Map<string, number>();

  function stateFor(sessionId: string): OomBreakerState {
    const t = now();
    const cutoff = t - windowMs;
    const arr = (ooms.get(sessionId) ?? []).filter((x) => x > cutoff);
    const tripped = trippedAt.has(sessionId);
    return {
      tripped,
      countInWindow: arr.length,
      lastOomAt: arr.length > 0 ? arr[arr.length - 1] ?? null : null,
      trippedAt: trippedAt.get(sessionId) ?? null,
      threshold,
      windowMs,
    };
  }

  return {
    recordOom(sessionId: string): OomRecordResult {
      const t = now();
      const cutoff = t - windowMs;
      const arr = (ooms.get(sessionId) ?? []).filter((x) => x > cutoff);
      arr.push(t);
      ooms.set(sessionId, arr);

      const alreadyTripped = trippedAt.has(sessionId);
      const shouldTrip = arr.length >= threshold;
      let justTripped = false;

      if (shouldTrip && !alreadyTripped) {
        trippedAt.set(sessionId, t);
        justTripped = true;
      }

      return {
        ...stateFor(sessionId),
        justTripped,
      };
    },
    forceTrip(sessionId: string): OomRecordResult {
      const t = now();
      const alreadyTripped = trippedAt.has(sessionId);
      let justTripped = false;
      if (!alreadyTripped) {
        trippedAt.set(sessionId, t);
        justTripped = true;
      }
      return { ...stateFor(sessionId), justTripped };
    },
    isTripped(sessionId: string): boolean {
      return trippedAt.has(sessionId);
    },
    getState(sessionId: string): OomBreakerState {
      return stateFor(sessionId);
    },
    reset(sessionId: string): void {
      ooms.delete(sessionId);
      trippedAt.delete(sessionId);
    },
    forget(sessionId: string): void {
      ooms.delete(sessionId);
      trippedAt.delete(sessionId);
    },
  };
}
