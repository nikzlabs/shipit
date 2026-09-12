

import { create } from "zustand";
import type { IssueWriteCard, IssueWriteUndoState } from "../../server/shared/types.js";

interface IssueWriteStore {
  cards: Record<string, IssueWriteCard>;

  upsertCard: (card: IssueWriteCard) => void;

  seedCards: (cards: IssueWriteCard[]) => void;

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
