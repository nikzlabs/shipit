/**
 * egress-prompt-store — inline egress allow-once card state (docs/172, SHI-90).
 *
 * Keyed by the stable `cardId` (per session+host) so an `egress_prompt_resolved`
 * update can swap a card to its terminal phase in place. The host + phase live
 * here rather than on the chat message so the card can render its live state
 * without re-threading through the message list.
 */

import { create } from "zustand";

export type EgressPromptPhase = "pending" | "allowed-once" | "added" | "denied";

export interface EgressPromptCardState {
  cardId: string;
  host: string;
  phase: EgressPromptPhase;
}

interface EgressPromptStore {
  cards: Record<string, EgressPromptCardState>;
  /**
   * Seed a card from a live `egress_prompt_card` event. Idempotent and
   * non-clobbering: a card already present (from persisted history or a
   * turn-event-buffer replay on reconnect) is left untouched, so a re-delivered
   * `pending` can't reset a card the user has already resolved.
   */
  upsertCard: (card: Omit<EgressPromptCardState, "phase">) => void;
  /** Authoritative hydration from persisted chat history (final phase wins). */
  seedCards: (cards: EgressPromptCardState[]) => void;
  /** Terminal transition from a user decision. */
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
