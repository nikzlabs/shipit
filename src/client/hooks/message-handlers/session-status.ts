import type { WsSessionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionStatus: Handler<WsSessionStatus> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setActiveRunnerSessions((prev) => {
    const next = new Set(prev);
    if (data.running) { next.add(data.sessionId); } else { next.delete(data.sessionId); }
    return next;
  });
  if (data.sessionId === useSessionStore.getState().sessionId) {
    session.setIsLoading(data.running);
    if (!data.running) {
      session.setActivity(undefined);
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
