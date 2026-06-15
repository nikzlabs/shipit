import type { WsActionChecklistCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/207 / SHI-153 — an action checklist card (the agent ran `propose_actions`).
 * Append a marker chat message carrying the full payload so it renders inline
 * where the actions were proposed. The card has no lifecycle and no client store
 * (it's an immutable, reusable message composer), so — like the issue-ref card —
 * the full payload lives on the message and a history reload rehydrates it
 * verbatim via `loadSessionHistory`.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * history, once from the buffer replay). Skip the duplicate append.
 */
export const handleActionChecklistCard: Handler<WsActionChecklistCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.actionChecklist?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.actionChecklist?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", actionChecklist: data.card }],
  );
};
