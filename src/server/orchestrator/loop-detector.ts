const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

const DEFAULT_THRESHOLD = 3;

const DEFAULT_COOLDOWN_MS = 60 * 1000;

export interface LoopDetectorOpts {
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface LoopAlert {
  sessionId: string;
  countInWindow: number;
  windowMs: number;
  threshold: number;
}

export interface SessionLoopDetector {
  recordContainerStarted(sessionId: string): LoopAlert | null;

  forget(sessionId: string): void;

  countInWindow(sessionId: string): number;
}

export function createSessionLoopDetector(opts: LoopDetectorOpts = {}): SessionLoopDetector {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;

  const events = new Map<string, number[]>();
  const alertedAt = new Map<string, number>();

  return {
    recordContainerStarted(sessionId: string): LoopAlert | null {
      const t = now();
      const cutoff = t - windowMs;
      const arr = (events.get(sessionId) ?? []).filter((x) => x > cutoff);
      arr.push(t);
      events.set(sessionId, arr);
      if (arr.length < threshold) return null;
      const lastAlert = alertedAt.get(sessionId) ?? 0;
      if (t - lastAlert < cooldownMs) return null;
      alertedAt.set(sessionId, t);
      return { sessionId, countInWindow: arr.length, windowMs, threshold };
    },
    forget(sessionId: string): void {
      events.delete(sessionId);
      alertedAt.delete(sessionId);
    },
    countInWindow(sessionId: string): number {
      const t = now();
      const cutoff = t - windowMs;
      return (events.get(sessionId) ?? []).filter((x) => x > cutoff).length;
    },
  };
}
