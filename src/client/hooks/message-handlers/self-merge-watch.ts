import type { WsSelfMergeWatchCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/239 — render the `SelfMergeWatchCard` when this session arms a watch on
 * its OWN pull request.
 *
 * Unlike docs/196's merge card this one fires MID-TURN (the agent's
 * `notify-on-merge --self` tool call), so it rides `emitChatCard` and is both
 * persisted in chat history and buffered into the turn-event log — a reconnect
 * can therefore deliver it twice (once from `loadSessionHistory`, once from the
 * buffer replay). Dedupe by the stable `cardId`. The static payload passes
 * straight through; the Cancel button's result is component-local.
 */
export const handleSelfMergeWatchCard: Handler<WsSelfMergeWatchCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.selfMergeWatch?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.selfMergeWatch?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", selfMergeWatch: data.card }],
  );
};
