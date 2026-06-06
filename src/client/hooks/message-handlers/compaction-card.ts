import type { WsCompactionCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/178 — the persisted "Context compacted" transcript card. Append a
 * `CompactionCard` to the chat transcript and clear the transient "Compacting…"
 * indicator (the card is the terminal record).
 *
 * Idempotent by card id: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * loadSessionHistory, once from the buffer replay). Skip the duplicate append.
 * The same idempotency holds against the persisted copy `loadSessionHistory`
 * rehydrates, so a card never double-renders or clobbers on reload.
 */
export const handleCompactionCard: Handler<WsCompactionCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setCompacting(false);
  if (session.messages.some((m) => m.compaction?.id === data.card.id)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.compaction?.id === data.card.id)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", compaction: data.card }],
  );
};
