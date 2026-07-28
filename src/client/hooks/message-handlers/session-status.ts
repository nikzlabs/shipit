import type { WsSessionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/235 — chat status line for a session waiting on agent-initiated
 * background work. Names the task when there is exactly one (the common case,
 * and the only one where a name is unambiguous); falls back to a count
 * otherwise so the line never grows unbounded.
 */
export function backgroundTaskLabel(descriptions: string[]): string {
  const only = descriptions.length === 1 ? descriptions[0]?.trim() : undefined;
  if (only) {
    const short = only.length > 60 ? `${only.slice(0, 57)}…` : only;
    return `Waiting for: ${short}`;
  }
  if (descriptions.length > 1) {
    return `Waiting for ${descriptions.length} background tasks to finish`;
  }
  return "Waiting for a background task to finish";
}

export const handleSessionStatus: Handler<WsSessionStatus> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setActiveRunnerSessions((prev) => {
    const next = new Set(prev);
    if (data.running) { next.add(data.sessionId); } else { next.delete(data.sessionId); }
    return next;
  });
  // docs/235 — outstanding background tasks. Only acted on when the field is
  // present: absent means "this status message says nothing about tasks", not
  // "there are none", so an unrelated status update can't clear a live marker.
  const bg = data.backgroundTasks;
  if (bg) {
    session.setBackgroundTaskSessions((prev) => {
      const next = new Set(prev);
      if (bg.count > 0) { next.add(data.sessionId); } else { next.delete(data.sessionId); }
      return next;
    });
  }
  // Effective pending state. When this message carries no `backgroundTasks`
  // field we fall back to the store — the turn-end status emitted by
  // `agent_result` is exactly such a message, and without the fallback a turn
  // that ended with work still outstanding would clear the indicator.
  const hasPendingTasks = bg
    ? bg.count > 0
    : useSessionStore.getState().backgroundTaskSessions.has(data.sessionId);
  if (data.sessionId === useSessionStore.getState().sessionId) {
    // docs/235 — the status bar stays up while background work is outstanding:
    // the session is not idle, it is waiting, and a cleared bar reads as
    // "finished".
    session.setIsLoading(data.running || hasPendingTasks);
    if (!data.running) {
      // `tool` is deliberately left unset — no tool call is running, so the
      // tool spinner would be a lie.
      if (hasPendingTasks) {
        session.setActivity({ label: backgroundTaskLabel(bg?.descriptions ?? []) });
      } else {
        session.setActivity(undefined);
      }
      // docs/178 — a turn that compacted and then ended without an
      // `agent_compacted` (e.g. it errored mid-compaction) would otherwise leave
      // the transient "Compacting…" indicator stuck on. Clearing it at every
      // turn end is a cheap backstop.
      session.setCompacting(false);
    }
    if (data.lastInterruptError) {
      session.setInterruptError(data.lastInterruptError);
    }
    if (data.reason === "idle-disposed" || data.reason === "memory-pressure") {
      session.setPauseNotice({
        reason: data.reason,
        ...(data.idleMs !== undefined ? { idleMs: data.idleMs } : {}),
        at: Date.now(),
      });
    }
  }
};
