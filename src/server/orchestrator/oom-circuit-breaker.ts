// Trips persist until reset or process restart; automatic expiry would restart the OOM loop.
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

const DEFAULT_THRESHOLD = 3;

export interface OomCircuitBreakerOpts {
  windowMs?: number;
  threshold?: number;
  now?: () => number;
}

export interface OomBreakerState {
  tripped: boolean;
  countInWindow: number;
  lastOomAt: number | null;
  trippedAt: number | null;
  threshold: number;
  windowMs: number;
}

export interface OomRecordResult extends OomBreakerState {
  justTripped: boolean;
}

export interface SessionOomCircuitBreaker {
  recordOom(sessionId: string): OomRecordResult;

  forceTrip(sessionId: string): OomRecordResult;

  isTripped(sessionId: string): boolean;

  getState(sessionId: string): OomBreakerState;

  reset(sessionId: string): void;

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
