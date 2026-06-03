/**
 * bug-report-store — inline bug-report consent card state (docs/164).
 *
 * Keyed by the stable `cardId` so a `bug_report_filed` / `bug_report_failed`
 * update can swap a card to its terminal state in place. The card payload
 * (redacted title + body) lives here rather than on the chat message so the
 * card component can hold the user's in-progress edits and the lifecycle phase
 * without re-threading them through the message list on every keystroke.
 */

import { create } from "zustand";

export type BugReportPhase = "draft" | "filing" | "filed" | "failed";

export interface BugReportCardState {
  cardId: string;
  phase: BugReportPhase;
  title: string;
  body: string;
  /** False → the deep semantic redaction pass didn't run; the card warns. */
  stage2Ran: boolean;
  producer: "session" | "ops";
  /** GitHub login the issue is filed as. */
  filedAs?: string;
  /** Set in the `filed` phase. */
  issueNumber?: number;
  issueUrl?: string;
  /** Set in the `failed` phase. */
  errorMessage?: string;
  scopeError?: boolean;
}

interface BugReportStore {
  cards: Record<string, BugReportCardState>;
  /**
   * Seed a new draft card from a live `bug_report_card` event. Idempotent and
   * non-clobbering: if a card with this id already exists (seeded from persisted
   * history, or re-delivered by a turn-event-buffer replay on reconnect) it is
   * left untouched, so a re-delivered *draft* can't reset a card that has since
   * been filed.
   */
  upsertCard: (card: Omit<BugReportCardState, "phase">) => void;
  /**
   * Authoritative hydration from persisted chat history (docs/164). Overwrites
   * any existing entry so the final persisted phase (e.g. `filed` with its issue
   * link) wins over a draft a buffer replay may have created first.
   */
  seedCards: (cards: BugReportCardState[]) => void;
  /** Mark a card as filing (optimistic) on submit. */
  setFiling: (cardId: string) => void;
  /** Terminal success. */
  setFiled: (cardId: string, issueNumber: number, issueUrl: string) => void;
  /** Terminal failure (back to an editable draft so the user can retry). */
  setFailed: (cardId: string, message: string, scopeError?: boolean) => void;
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
                // Drop back to an editable draft so the user can fix their
                // token / edit the body and resubmit.
                phase: "draft",
                errorMessage: message,
                ...(scopeError ? { scopeError: true } : { scopeError: false }),
              },
            },
          }
        : s,
    ),
  reset: () => set({ cards: {} }),
}));
