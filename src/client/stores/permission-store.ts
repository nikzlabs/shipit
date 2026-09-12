

import { create } from "zustand";

export type PermissionPhase = "pending" | "approved" | "denied";

export interface PermissionCardState {
  requestId: string;
  phase: PermissionPhase;
  toolName: string;
  path?: string;
  summary?: string;

  details?: string;
  agentId?: string;
  createdAt?: string;

  remembered?: boolean;
}

interface PermissionStore {
  cards: Record<string, PermissionCardState>;

  upsertCard: (card: Omit<PermissionCardState, "phase">) => void;

  seedCards: (cards: PermissionCardState[]) => void;

  setPending: (requestId: string) => void;

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
