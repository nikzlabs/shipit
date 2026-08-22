import type { WsPresentInlineCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/280 — an inline presentation card (the agent ran `present({ inline: true })`).
 * Append a marker chat message carrying the artifact's metadata so it renders
 * where the tool fired. The card has no lifecycle and no client store of its own
 * — the artifact's bytes come from the present store on demand — so both the
 * live WS handler and a history rehydration carry the same payload and the
 * component renders straight from it.
 *
 * Idempotent by `presentId`: the card is both persisted to chat history and
 * buffered into the turn-event log, so a reconnect can deliver it twice (once
 * from history, once from the buffer replay). The server also emits it exactly
 * once per artifact, so a second card for the same id is always a replay.
 */
export const handlePresentInlineCard: Handler<WsPresentInlineCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.presentInline?.presentId === data.card.presentId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.presentInline?.presentId === data.card.presentId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", presentInline: data.card }],
  );
};
