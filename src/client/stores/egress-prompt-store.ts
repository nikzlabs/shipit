

import { create } from "zustand";

export type EgressPromptPhase = "pending" | "allowed-once" | "added" | "denied";

export interface EgressPromptCardState {
  cardId: string;
  host: string;
  phase: EgressPromptPhase;
}

interface EgressPromptStore {
  cards: Record<string, EgressPromptCardState>;

  upsertCard: (card: Omit<EgressPromptCardState, "phase">) => void;

  seedCards: (cards: EgressPromptCardState[]) => void;

  setPhase: (cardId: string, phase: EgressPromptPhase) => void;
  reset: () => void;
}

export const useEgressPromptStore = create<EgressPromptStore>((set) => ({
  cards: {},
  upsertCard: (card) =>
    set((s) =>
      s.cards[card.cardId]
        ? s
        : { cards: { ...s.cards, [card.cardId]: { ...card, phase: "pending" } } },
    ),
  seedCards: (cards) =>
    set((s) => {
      const next = { ...s.cards };
      for (const c of cards) next[c.cardId] = c;
      return { cards: next };
    }),
  setPhase: (cardId, phase) =>
    set((s) =>
      s.cards[cardId] ? { cards: { ...s.cards, [cardId]: { ...s.cards[cardId], phase } } } : s,
    ),
  reset: () => set({ cards: {} }),
}));
