

import { create } from "zustand";

export type BugReportPhase = "draft" | "filing" | "filed" | "failed" | "dismissed";

export interface BugReportCardState {
  cardId: string;
  phase: BugReportPhase;
  title: string;
  body: string;

  stage2Ran: boolean;
  producer: "session" | "ops";

  filedAs?: string;

  issueNumber?: number;
  issueUrl?: string;

  errorMessage?: string;
  scopeError?: boolean;
}

interface BugReportStore {
  cards: Record<string, BugReportCardState>;

  upsertCard: (card: Omit<BugReportCardState, "phase">) => void;

  seedCards: (cards: BugReportCardState[]) => void;

  setFiling: (cardId: string) => void;

  setFiled: (cardId: string, issueNumber: number, issueUrl: string) => void;

  setFailed: (cardId: string, message: string, scopeError?: boolean) => void;
  /**
   * Terminal decline (nikzlabs/shipit#2350). Never overwrites a `filed` card — a stale
   * `bug_report_dismissed` replay must not undo a success.
   */
  setDismissed: (cardId: string) => void;
  reset: () => void;
}

export const useBugReportStore = create<BugReportStore>((set) => ({
  cards: {},
  upsertCard: (card) =>
    set((s) =>
      s.cards[card.cardId]
        ? s
        : { cards: { ...s.cards, [card.cardId]: { ...card, phase: "draft" } } },
    ),
  seedCards: (cards) =>
    set((s) => {
      const next = { ...s.cards };
      for (const c of cards) next[c.cardId] = c;
      return { cards: next };
    }),
  setFiling: (cardId) =>
    set((s) =>
      s.cards[cardId]
        ? { cards: { ...s.cards, [cardId]: { ...s.cards[cardId], phase: "filing" } } }
        : s,
    ),
  setFiled: (cardId, issueNumber, issueUrl) =>
    set((s) =>
      s.cards[cardId]
        ? {
            cards: {
              ...s.cards,
              [cardId]: { ...s.cards[cardId], phase: "filed", issueNumber, issueUrl },
            },
          }
        : s,
    ),
  setFailed: (cardId, message, scopeError) =>
    set((s) =>
      s.cards[cardId]
        ? {
            cards: {
              ...s.cards,
              [cardId]: {
                ...s.cards[cardId],

                phase: "draft",
                errorMessage: message,
                ...(scopeError ? { scopeError: true } : { scopeError: false }),
              },
            },
          }
        : s,
    ),
  setDismissed: (cardId) =>
    set((s) =>
      s.cards[cardId] && s.cards[cardId].phase !== "filed"
        ? { cards: { ...s.cards, [cardId]: { ...s.cards[cardId], phase: "dismissed" } } }
        : s,
    ),
  reset: () => set({ cards: {} }),
}));
