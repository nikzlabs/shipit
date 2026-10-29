

import { create } from "zustand";
import type { PermissionUnanswered } from "../../server/shared/types.js";

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
  unanswered?: PermissionUnanswered;
}

interface PermissionStore {
  cards: Record<string, PermissionCardState>;

  upsertCard: (card: Omit<PermissionCardState, "phase">) => void;

  seedCards: (cards: PermissionCardState[]) => void;

  setPending: (requestId: string) => void;

  setResolved: (
    requestId: string,
    phase: Exclude<PermissionPhase, "pending">,
    remembered?: boolean,
    unanswered?: PermissionUnanswered,
  ) => void;
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
  setResolved: (requestId, phase, remembered, unanswered) =>
    set((s) =>
      s.cards[requestId]
        ? {
            cards: {
              ...s.cards,
              [requestId]: {
                ...s.cards[requestId],
                phase,
                ...(remembered ? { remembered: true } : {}),
                ...(unanswered ? { unanswered } : {}),
              },
            },
          }
        : s,
    ),
  reset: () => set({ cards: {} }),
}));
