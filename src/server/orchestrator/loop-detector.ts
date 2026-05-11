/**
 * Session container loop detector.
 *
 * Field reports show session containers occasionally entering a SIGTERM
 * → recreate loop where the same session ID gets a new container every
 * 30-60s for many minutes. The loop is intermittent (often resolved by
 * an orchestrator restart), which makes it hard to investigate after
 * the fact.
 *
 * This detector tracks `container_started` events per session over a
 * sliding window and emits a uniquely greppable warning line when the
 * rate crosses the threshold. The line goes to both `console.error`
 * (for journalctl) and the per-session log ring (for the diagnostics
 * endpoint). With an alert cooldown to avoid spamming during a
 * sustained loop.
 *
 * Pure module — no Docker access, no I/O. Tested in isolation.
 */

/** Sliding window: count creates in the last N ms. */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** Alert when the window count reaches this many creates. */
const DEFAULT_THRESHOLD = 3;

/** After alerting, suppress further alerts for this long. */
const DEFAULT_COOLDOWN_MS = 60 * 1000;

export interface LoopDetectorOpts {
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  /** Time source — overridable for tests. */
  now?: () => number;
}

export interface LoopAlert {
  sessionId: string;
  countInWindow: number;
  windowMs: number;
  threshold: number;
}

export interface SessionLoopDetector {
  /**
   * Record a container_started event. Returns a `LoopAlert` if the
   * rate just crossed the threshold (respecting the per-session
   * alert cooldown). Returns `null` if no alert should fire.
   */
  recordContainerStarted(sessionId: string): LoopAlert | null;

  /** Drop all state for a session — call on session archive / remove. */
  forget(sessionId: string): void;

  /** Test-only: peek at the current event count for a session. */
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
