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

  const pendingTasks = useSessionStore.getState().backgroundTaskSessions.get(data.sessionId);
  const hasPendingTasks = pendingTasks !== undefined;
  if (data.sessionId === useSessionStore.getState().sessionId) {

    session.setIsLoading(data.running || hasPendingTasks);
    if (!data.running) {

      if (pendingTasks) {
        session.setActivity({ label: backgroundTaskLabel(pendingTasks) });
      } else {
        session.setActivity(undefined);
      }

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
