/**
 * permission-store — inline permission-request card state (docs/193 / SHI-112).
 *
 * Keyed by the stable `requestId` (the worker broker's id) so a
 * `permission_resolved` update can swap a card to its terminal state in place.
 * The card's display payload + phase live here rather than on the chat message
 * so the optimistic phase flip on click, and the authoritative terminal state,
 * don't have to re-thread through the message list.
 */

import { create } from "zustand";

export type PermissionPhase = "pending" | "approved" | "denied" | "expired";

export interface PermissionCardState {
  requestId: string;
  phase: PermissionPhase;
  toolName: string;
  path?: string;
  summary?: string;
  agentId?: string;
  createdAt?: string;
  /** True when approved with "remember this file for the session". */
  remembered?: boolean;
}

interface PermissionStore {
  cards: Record<string, PermissionCardState>;
  /**
   * Seed a card from a live `permission_request_card` event. Idempotent and
   * non-clobbering: a card already present (seeded from persisted history or
   * re-delivered by a turn-event-buffer replay on reconnect) is left untouched,
   * so a re-delivered pending card can't reset one that has since resolved.
   */
  upsertCard: (card: Omit<PermissionCardState, "phase">) => void;
  /** Authoritative hydration from persisted chat history (overwrites). */
  seedCards: (cards: PermissionCardState[]) => void;
  /** Optimistic phase flip on click (before the server confirms). */
  setPending: (requestId: string) => void;
  /** Terminal state from a `permission_resolved` event. */
  setResolved: (requestId: string, phase: Exclude<PermissionPhase, "pending">, remembered?: boolean) => void;
  reset: () => void;
}

export const usePermissionStore = create<PermissionStore>((set) => ({
  cards: {},
  upsertCard: (card) =>
    set((s) =>
      s.cards[card.requestId]
        ? s
        : { cards: { ...s.cards, [card.requestId]: { ...card, phase: "pending" } } },
    ),
  seedCards: (cards) =>
    set((s) => {
      const next = { ...s.cards };
      for (const c of cards) next[c.requestId] = c;
      return { cards: next };
    }),
  setPending: (requestId) =>
    set((s) =>
      s.cards[requestId]
        ? { cards: { ...s.cards, [requestId]: { ...s.cards[requestId], phase: "pending" } } }
        : s,
    ),
  setResolved: (requestId, phase, remembered) =>
    set((s) =>
      s.cards[requestId]
        ? {
            cards: {
              ...s.cards,
              [requestId]: {
                ...s.cards[requestId],
                phase,
                ...(remembered ? { remembered: true } : {}),
              },
            },
          }
        : s,
    ),
  reset: () => set({ cards: {} }),
}));
