import type { WsRewindComplete } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileStore } from "../../stores/file-store.js";
import type { Handler } from "./types.js";

export const handleRewindComplete: Handler<WsRewindComplete> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const { messageIndex } = data;
  // Remove the target user message and everything after it
  session.setMessages((prev) => prev.slice(0, messageIndex));
  // Refresh file tree
  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentSessionId) {
    useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
  }
};
