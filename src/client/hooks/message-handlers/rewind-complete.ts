import type { WsRewindComplete } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileStore } from "../../stores/file-store.js";
import type { Handler } from "./types.js";

export const handleRewindComplete: Handler<WsRewindComplete> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const gapPosition = "gapPosition" in data ? data.gapPosition : (data.messageIndex ?? 0);
  if ("action" in data && data.action === "code") {
    session.setMessages((prev) => prev.map((m, i) => {
      if (i < gapPosition) return m;
      return { ...m, rolledBack: true, codeRollbackHash: i === gapPosition ? data.commitHash : m.codeRollbackHash };
    }));
  } else if ("action" in data && data.action === "chat" && gapPosition === 0) {
    session.setMessages([{
      role: "assistant",
      text: "Conversation rewound to start. Send a message to continue.",
      notice: true,
      noticeLevel: "info",
    }]);
  } else {
    session.setMessages((prev) => prev.slice(0, gapPosition));
  }
  // Refresh file tree
  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentSessionId) {
    useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
  }
};
