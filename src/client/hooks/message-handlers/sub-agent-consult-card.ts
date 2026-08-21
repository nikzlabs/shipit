import type { WsSubAgentConsultCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/144 — the persisted sub-agent consult card. Two deliveries share this
 * handler (planning#280):
 *
 *  - **at spawn**, `status: "pending"` — the durable in-flight record. Appended
 *    inline at the call site, so a backgrounded consult survives the session
 *    switch that wipes the transient `sub_agent_spawn` spinner.
 *  - **at completion**, the SAME `cardId` with a terminal status — patched into
 *    the existing message in place rather than appended, so the transcript shows
 *    one card that transitions instead of two.
 *
 * Idempotent by card id: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * `loadSessionHistory`, once from the buffer replay). An in-place patch with an
 * identical payload is a no-op, so that idempotency still holds — including
 * against the persisted copy `loadSessionHistory` rehydrates, so the card never
 * double-renders on reload.
 *
 * The transient spinner is cleared only on a TERMINAL card; a pending card means
 * the consult is still in flight.
 */
export const handleSubAgentConsultCard: Handler<WsSubAgentConsultCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (data.card.status !== "pending") session.removeSubAgentSpawn(data.card.spawnId);
  session.setMessages((prev) => {
    const idx = prev.findIndex((m) => m.subAgentConsult?.cardId === data.card.cardId);
    if (idx < 0) return [...prev, { role: "assistant" as const, text: "", subAgentConsult: data.card }];
    const next = prev.slice();
    next[idx] = { ...next[idx], subAgentConsult: data.card };
    return next;
  });
};
