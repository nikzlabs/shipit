import type { WsReleaseCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleReleaseCard: Handler<WsReleaseCard> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const idx = prev.findIndex((m) => m.releaseCard?.cardId === data.card.cardId);
    if (idx === -1) {
      return [...prev, { role: "assistant" as const, text: "", releaseCard: data.card }];
    }
    const next = prev.slice();
    next[idx] = { ...next[idx], releaseCard: data.card };
    return next;
  });
};
