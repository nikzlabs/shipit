import type { WsBranchSyncedCard } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/221 — a "Synced with <base>" card: a manual "Sync with <base>" flow
 * rebased the session branch onto `origin/<base>` and/or fast-forwarded the local
 * `<base>` ref. Append a marker chat message carrying the full payload so it
 * renders inline. The card has no lifecycle and no client store, so — like the
 * branch-auto-reset / action-checklist cards — the full payload lives on the
 * message and a history reload rehydrates it verbatim via `loadSessionHistory`.
 *
 * Idempotent by cardId: the card is both appended to chat history and buffered
 * into the turn-event log, so a reconnect can deliver it twice (once from history,
 * once from the buffer replay). Skip the duplicate append.
 */
export const handleBranchSyncedCard: Handler<WsBranchSyncedCard> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.messages.some((m) => m.branchSynced?.cardId === data.card.cardId)) return;

  session.setMessages((prev) =>
    prev.some((m) => m.branchSynced?.cardId === data.card.cardId)
      ? prev
      : [...prev, { role: "assistant" as const, text: "", branchSynced: data.card }],
  );
};
