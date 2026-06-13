import type { WsSubAgentConsultCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/144 — the persisted "Consulted Codex · 47s" transcript card. Appends a
 * `subAgentConsult` chat message at its current (inline) position and clears the
 * transient in-flight spinner by `spawnId` (the card is the terminal record).
 *
 * Idempotent by card id: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * `loadSessionHistory`, once from the buffer replay). Skip the duplicate append.
 * The same idempotency holds against the persisted copy `loadSessionHistory`
 * rehydrates, so the card never double-renders on reload.
 */
export const handleSubAgentConsultCard: Handler<WsSubAgentConsultCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.removeSubAgentSpawn(data.card.spawnId);
  if (session.messages.some((m) => m.subAgentConsult?.cardId === data.card.cardId)) return;
  session.setMessages((prev) =>
    prev.some((m) => m.subAgentConsult?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", subAgentConsult: data.card }],
  );
};
