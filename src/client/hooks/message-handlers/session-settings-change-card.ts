import type { WsSessionSettingsChangeCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/279 — a "session settings changed" card (a sandbox capability grant
 * edited after creation, or a regular session's network containment mode
 * changed). Append a marker chat message carrying the full payload so it renders
 * inline where the change happened. The card has no lifecycle and no client
 * store, so — like the session-renamed / branch-auto-reset cards — the full
 * payload lives on the message and a history reload rehydrates it verbatim via
 * `loadSessionHistory`.
 *
 * The toggle positions themselves come from the session list (`session_list`
 * SSE) and the settings dialog's own fetch; this handler is only the transcript
 * row.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * history, once from the buffer replay). Skip the duplicate append.
 */
export const handleSessionSettingsChangeCard: Handler<WsSessionSettingsChangeCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.sessionSettingsChange?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.sessionSettingsChange?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", sessionSettingsChange: data.card }],
  );
};
