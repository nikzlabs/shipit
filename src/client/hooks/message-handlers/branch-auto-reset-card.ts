import type { WsBranchAutoResetCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/218 — a "branch updated to latest base" card (a merged session's branch was
 * auto-reset to `origin/<base>` before the turn ran). Append a marker chat message
 * carrying the full payload so it renders inline right after the user's message.
 * The card has no lifecycle and no client store, so — like the action-checklist /
 * issue-ref cards — the full payload lives on the message and a history reload
 * rehydrates it verbatim via `loadSessionHistory`.
 *
 * Idempotent by cardId: the card is both persisted to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from history,
 * once from the buffer replay). Skip the duplicate append.
 */
export const handleBranchAutoResetCard: Handler<WsBranchAutoResetCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.branchAutoReset?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.branchAutoReset?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", branchAutoReset: data.card }],
  );
};
