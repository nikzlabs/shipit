/**
 * issue-write-store — inline issue-write provenance card state (docs/177).
 *
 * Keyed by the stable `cardId` so an `issue_write_update` (undoing → undone |
 * failed) can swap a card to its terminal state in place. The full card payload
 * (summary, identifier, undo snapshot, attribution) lives here rather than on
 * the chat message so the card component reads one source and the message only
 * carries the `cardId` (same split as the bug-report card).
 */

import { create } from "zustand";
import type { IssueWriteCard, IssueWriteUndoState } from "../../server/shared/types.js";

interface IssueWriteStore {
  cards: Record<string, IssueWriteCard>;
  /**
   * Seed a card from a live `issue_write_card` event. Idempotent and
   * non-clobbering: if a card with this id already exists (rehydrated from
   * history, or re-delivered by a turn-event-buffer replay on reconnect) it is
   * left untouched, so a re-delivered card can't reset one already undone.
   */
  upsertCard: (card: IssueWriteCard) => void;
  /**
   * Authoritative hydration from persisted chat history. Overwrites existing
   * entries so the final persisted undo state (e.g. `undone`) wins over a card
   * a buffer replay may have created first as `available`.
   */
  seedCards: (cards: IssueWriteCard[]) => void;
  /** Apply an undo lifecycle transition keyed by cardId. */
  setUndoState: (cardId: string, undoState: IssueWriteUndoState, errorMessage?: string) => void;
  reset: () => void;
}

export const useIssueWriteStore = create<IssueWriteStore>((set) => ({
  cards: {},
  upsertCard: (card) =>
    set((s) => (s.cards[card.cardId] ? s : { cards: { ...s.cards, [card.cardId]: card } })),
  seedCards: (cards) =>
    set((s) => {
      const next = { ...s.cards };
      for (const c of cards) next[c.cardId] = c;
      return { cards: next };
    }),
  setUndoState: (cardId, undoState, errorMessage) =>
    set((s) =>
      s.cards[cardId]
        ? {
            cards: {
              ...s.cards,
              [cardId]: { ...s.cards[cardId], undoState, errorMessage },
            },
          }
        : s,
    ),
  reset: () => set({ cards: {} }),
}));
