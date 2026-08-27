/**
 * docs/235 — per-runner view of the agent backend's outstanding background
 * tasks (a `Bash(run_in_background)` job, a scheduled wake-up, …).
 *
 * Why this is a *hint* and not a fact. The backend reports the list only when
 * it CHANGES: neither a new turn nor a fresh `init` re-states an outstanding
 * list, there is no heartbeat, and there is no pull API to ask with. So the
 * orchestrator's copy is exactly as good as its event delivery, and a single
 * dropped frame would otherwise pin `agentBusy` true forever — making the
 * session permanently unreclaimable, the same failure class the
 * `running = false` reset in `agent-listeners.ts` exists to prevent.
 *
 * Two independent bounds keep that from happening, both of which make the
 * tracker fail toward *reclaimable* (the safe direction for a resource guard):
 *
 *  1. **Process-liveness gate.** A background task cannot outlive the agent CLI
 *     process — the CLI reaps its background work when it exits (verified in
 *     docs/235: a one-shot `-p` run's backgrounded `sleep 12` never completed).
 *     So a non-zero count is only meaningful while a streaming process is
 *     resident; `count(false)` is definitionally 0.
 *  2. **Decay.** Even with the process alive, honor a non-zero count for at
 *     most {@link BACKGROUND_TASK_TTL_MS}. A missed "drained" event then costs
 *     one window of extra container lifetime instead of a permanent leak.
 *
 * Deliberately NOT a source of truth for the UI count beyond that window: if
 * the tracker has gone quiet for longer than the TTL, we would rather show a
 * session as idle (and let the next real event correct us) than keep a spinner
 * up forever.
 */

/**
 * How long a non-zero background-task count is honored without a refresh.
 *
 * A stale count reads as `agentBusy`, and a busy session is never reclaimed —
 * so without a TTL one dropped event would pin a container for the life of the
 * process. Ten minutes bounds that to a single window.
 *
 * It used to be defined as the idle enforcer's grace period, which docs/284
 * removed when reclaim stopped being driven by elapsed time. The value was
 * always about how long to trust a stale reading, so it keeps it as its own.
 */
export const BACKGROUND_TASK_TTL_MS = 600_000;

/** One outstanding background task, normalized across agent backends. */
export interface BackgroundTaskInfo {
  id: string;
  type?: string;
  description?: string;
}

export class BackgroundTaskTracker {
  private tasks: BackgroundTaskInfo[] = [];
  private seenAt = 0;

  /**
   * Replace the list wholesale. The backend reports the complete current set
   * (empty = drained), never a delta, so this is an assignment rather than a
   * merge — that is what lets a single event fully re-state the truth.
   */
  set(tasks: BackgroundTaskInfo[]): void {
    this.tasks = tasks;
    this.seenAt = tasks.length > 0 ? Date.now() : 0;
  }

  /** Drop everything — the agent process died, so its tasks died with it. */
  clear(): void {
    this.tasks = [];
    this.seenAt = 0;
  }

  /**
   * Outstanding task count, after the liveness gate and the TTL decay.
   *
   * @param streamingActive whether a streaming agent process is currently
   *   resident. False collapses the count to 0 (see bound 1 above).
   */
  count(streamingActive: boolean, now: number = Date.now()): number {
    if (!streamingActive) return 0;
    if (this.tasks.length === 0) return 0;
    if (now - this.seenAt >= BACKGROUND_TASK_TTL_MS) return 0;
    return this.tasks.length;
  }

  /**
   * Descriptions of the outstanding tasks, for the chat status line. Subject to
   * the same gate/decay as {@link count} so the label can never outlive the
   * state it describes.
   */
  descriptions(streamingActive: boolean, now: number = Date.now()): string[] {
    if (this.count(streamingActive, now) === 0) return [];
    return this.tasks.map((t) => t.description ?? t.id);
  }
}
