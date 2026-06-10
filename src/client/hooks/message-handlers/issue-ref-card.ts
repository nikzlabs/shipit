import type { WsIssueRefCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/188 — a read-only issue navigation card (the agent ran `shipit issue
 * view`). Append a marker chat message carrying the full payload so it renders
 * inline where the read happened. The card has no lifecycle, so — unlike the
 * write card — there is no store; the payload lives on the message and a history
 * reload rehydrates it verbatim via `loadSessionHistory`.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * history, once from the buffer replay). Skip the duplicate append.
 */
export const handleIssueRefCard: Handler<WsIssueRefCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.issueRef?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.issueRef?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", issueRef: data.card }],
  );
};
