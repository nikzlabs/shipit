import type { WsIssueWriteCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useIssueWriteStore } from "../../stores/issue-write-store.js";
import type { Handler } from "./types.js";

/**
 * docs/177 — a do-then-surface issue-write provenance card. Seed the payload
 * into the issue-write store (keyed by cardId so a later undo update swaps it in
 * place) and append a marker chat message so it renders inline where the write
 * happened.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from
 * `loadSessionHistory`, once from the buffer replay). Skip the duplicate append
 * when a card with this id is already present; `upsertCard` is itself
 * non-clobbering so it can't reset a card already rehydrated as `undone`.
 */
export const handleIssueWriteCard: Handler<WsIssueWriteCard> = (_ctx, data) => {
  useIssueWriteStore.getState().upsertCard(data.card);

  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.issueWrite?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.issueWrite?.cardId === data.card.cardId)
      ? prev
      : [
          ...prev,
          {
            role: "assistant" as const,
            text: "",
            issueWrite: { cardId: data.card.cardId },
          },
        ],
  );
};
