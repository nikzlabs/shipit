import type { WsSessionRenamedCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/250 — a "renamed this session" card (the agent retitled its own session
 * via `shipit session rename`). Append a marker chat message carrying the full
 * payload so it renders inline at the point in the turn where the rename
 * happened. The card has no lifecycle and no client store, so — like the
 * branch-auto-reset / issue-ref cards — the full payload lives on the message and
 * a history reload rehydrates it verbatim via `loadSessionHistory`.
 *
 * The sidebar entry is updated separately by the `session_renamed` SSE event;
 * this handler is only the transcript row.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * history, once from the buffer replay). Skip the duplicate append.
 */
export const handleSessionRenamedCard: Handler<WsSessionRenamedCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.sessionRenamed?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.sessionRenamed?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", sessionRenamed: data.card }],
  );
};
