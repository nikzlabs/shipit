import type { WsSessionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { backgroundTaskLabel } from "./background-tasks.js";
import type { Handler } from "./types.js";

export const handleSessionStatus: Handler<WsSessionStatus> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setActiveRunnerSessions((prev) => {
    const next = new Set(prev);
    if (data.running) { next.add(data.sessionId); } else { next.delete(data.sessionId); }
    return next;
  });
  // docs/235 — a turn can end with background work still outstanding, and this
  // message says nothing about tasks (that's `background_tasks`' job), so read
  // the standing marker from the store. Without it, the turn-end status would
  // clear the indicator and the session would look finished while work runs on.
  const pendingTasks = useSessionStore.getState().backgroundTaskSessions.get(data.sessionId);
  const hasPendingTasks = pendingTasks !== undefined;
  if (data.sessionId === useSessionStore.getState().sessionId) {
    // docs/235 — the status bar stays up while background work is outstanding:
    // the session is not idle, it is waiting, and a cleared bar reads as
    // "finished".
    session.setIsLoading(data.running || hasPendingTasks);
    if (!data.running) {
      // `tool` is deliberately left unset — no tool call is running, so the
      // tool spinner would be a lie.
      if (pendingTasks) {
        session.setActivity({ label: backgroundTaskLabel(pendingTasks) });
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
    if (data.reason === "agent-reclaimed" || data.reason === "memory-pressure") {
      session.setPauseNotice({
        reason: data.reason,
        ...(data.idleMs !== undefined ? { idleMs: data.idleMs } : {}),
        at: Date.now(),
      });
    }
  }
};
