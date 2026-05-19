import type { WsRollbackComplete } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileStore } from "../../stores/file-store.js";
import type { Handler } from "./types.js";

export const handleRollbackComplete: Handler<WsRollbackComplete> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const { messageIndex, mode, parentCommitHash } = data;
  if (mode === "code") {
    // Code-only rollback: insert a divider after the rolled-back message
    session.setMessages((prev) => {
      const updated = [...prev];
      // Insert a system-style divider message after the target
      const divider = {
        role: "assistant" as const,
        text: `Code rolled back to ${parentCommitHash.slice(0, 7)}. The changes from the previous response have been reverted.`,
        isError: false,
        streaming: false,
      };
      updated.splice(messageIndex + 1, 0, divider);
      return updated;
    });
  } else {
    // Code + chat rollback: mark messages after messageIndex as rolled back
    session.setMessages((prev) => prev.map((m, i) =>
      i > messageIndex ? { ...m, rolledBack: true } : m
    ));
  }
  // Refresh git history and file tree
  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentSessionId) {
    useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
  }
};
