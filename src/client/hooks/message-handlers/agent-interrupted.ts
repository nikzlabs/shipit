import type { WsAgentInterrupted } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleAgentInterrupted: Handler<WsAgentInterrupted> = (_ctx, _data) => {
  const session = useSessionStore.getState();
  session.setIsLoading(false);
  session.setActivity(undefined);
  session.setQueuedMessages([]);
  session.setMessages((prev) => {
    const last = prev[prev.length - 1];
    const closed = prev.map((m) =>
      m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m
    );
    if (last?.role === "assistant" && last.streaming) {
      return [...closed.slice(0, -1), { ...last, streaming: false, text: `${last.text}\n\n_(Interrupted by user)_` }];
    }
    return closed;
  });
};
