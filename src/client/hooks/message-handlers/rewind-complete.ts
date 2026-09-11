import type { WsRewindComplete } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileStore, noteUploadsChanged } from "../../stores/file-store.js";
import { useGitStore } from "../../stores/git-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleRewindComplete: Handler<WsRewindComplete> = (_ctx, data) => {
  const session = useSessionStore.getState();
  const { gapPosition } = data;
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

  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentSessionId) {
    useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));

    if ("action" in data && (data.action === "code" || data.action === "both")) {
      useGitStore.getState().fetchLog(currentSessionId).catch((err: unknown) => console.warn("[git-log-refresh]", err));
    }

    if ("action" in data && (data.action === "chat" || data.action === "both")) {
      noteUploadsChanged(currentSessionId);
      void useFileStore.getState().hydrateUploads(currentSessionId);
    }
  }
  if ("snapshotSessionId" in data && data.snapshotSessionId && data.snapshotExpiresAt) {
    const recovery = {
      sessionId: data.snapshotSessionId,
      action: data.action,
      expiresAt: data.snapshotExpiresAt,
    };
    session.setRewindRecovery(recovery);
    useUiStore.getState().setToast({
      message: "Rewound.",
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => window.dispatchEvent(new CustomEvent("shipit:restore-rewind", { detail: { sessionId: recovery.sessionId } })),
      },
    });
  }
};
