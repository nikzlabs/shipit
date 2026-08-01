import type { WsError } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleError: Handler<WsError> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setIsLoading(false);
  session.setActivity(undefined);
  session.setMessages((prev) => {
    const withoutRejected = data.code === "repository_untrusted" && data.requestId
      ? prev.filter((m) => m.clientRequestId !== data.requestId)
      : prev;
    const updated = withoutRejected.map((m) =>
      m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
    );
    return [
      ...updated,
      { role: "assistant", text: `Error: ${data.message}`, streaming: false, isError: true },
    ];
  });
  if (data.code === "repository_untrusted" && data.requestId) {
    session.setPendingWsMessage(undefined);
    if (data.sessionId) {
      session.setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId!);
        return next;
      });
    }
  }
};
