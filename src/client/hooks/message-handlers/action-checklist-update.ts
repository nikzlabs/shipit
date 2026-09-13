import type { WsActionChecklistUpdate } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleActionChecklistUpdate: Handler<WsActionChecklistUpdate> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const index = prev.findIndex((m) => m.actionChecklist?.cardId === data.cardId);
    if (index < 0 || prev[index].actionChecklist?.submittedAt) return prev;
    const next = prev.slice();
    next[index] = {
      ...next[index],
      actionChecklist: { ...next[index].actionChecklist!, submittedAt: data.submittedAt },
    };
    return next;
  });
};
