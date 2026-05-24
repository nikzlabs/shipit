import type { WsSessionForked } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleSessionForked: Handler<WsSessionForked> = (_ctx, data) => {
  const childSessionId = data.childSessionId ?? data.sessionId;
  if (!childSessionId) return;
  useSessionStore.getState().setSessionId(childSessionId);
  window.history.pushState({}, "", `/session/${childSessionId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (data.snapshotSessionId && data.snapshotExpiresAt) {
    useSessionStore.getState().setRewindRecovery({
      sessionId: data.snapshotSessionId,
      action: "fork",
      expiresAt: data.snapshotExpiresAt,
    });
    useUiStore.getState().setToast({
      message: `Forked to ${data.title}.`,
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => window.dispatchEvent(new CustomEvent("shipit:restore-rewind", { detail: { sessionId: data.snapshotSessionId } })),
      },
    });
  }
};
