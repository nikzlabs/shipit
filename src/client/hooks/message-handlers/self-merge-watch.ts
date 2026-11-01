import type { WsSelfMergeWatchCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

// The server sends the card again when its watch ends, so a known card is replaced in place.
export const handleSelfMergeWatchCard: Handler<WsSelfMergeWatchCard> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => {
    const index = prev.findIndex((m) => m.selfMergeWatch?.cardId === data.card.cardId);
    if (index < 0) return [...prev, { role: "assistant" as const, text: "", selfMergeWatch: data.card }];
    // A replayed event must not undo an end that history already delivered. Same rule as the
    // server: the first end stays, except that a wake which was started can still fail.
    const known = prev[index].selfMergeWatch?.ended;
    if (known && !(known === "merged" && data.card.ended === "wake-failed")) return prev;
    if (!data.card.ended) return prev;
    const next = prev.slice();
    next[index] = { ...prev[index], selfMergeWatch: data.card };
    return next;
  });
};
