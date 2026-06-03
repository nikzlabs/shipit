import { create } from "zustand";
import type { ReleaseStatusSummary } from "../../server/shared/types/release-types.js";

/**
 * Release lifecycle card store (docs/171 Phase 1), modeled on `pr-store.ts`.
 * Cards are SSE-driven (`release_status`) and keyed by sessionId — exactly like
 * the PR card's poller-driven state — so the store is NOT reset on session
 * switch; each session reads its own card by id.
 *
 * The card state machine is `proposed | tagging | gating | published |
 * deploying | released | failed` (see `ReleaseStatusSummary.phase`).
 */
export type ReleaseCardState = ReleaseStatusSummary;

interface ReleaseState {
  /** sessionId → release card snapshot from the poller. */
  cardBySession: Record<string, ReleaseStatusSummary>;

  /**
   * Apply a `release_status` SSE payload. `removals` clears specific sessions;
   * `isSnapshot` marks the authoritative initial-connect set, so any session we
   * still hold a card for but that's absent from `updates` is dropped (a
   * reconnect converges to the server's current truth).
   */
  applyReleaseStatusUpdates: (
    updates: ReleaseStatusSummary[],
    removals?: string[],
    isSnapshot?: boolean,
  ) => void;

  /** Optimistically dismiss a card (e.g. the user clicked Cancel). */
  dismiss: (sessionId: string) => void;

  reset: () => void;
}

const initialState = {
  cardBySession: {} as Record<string, ReleaseStatusSummary>,
};

export const useReleaseStore = create<ReleaseState>((set) => ({
  ...initialState,

  applyReleaseStatusUpdates: (updates, removals, isSnapshot) => {
    set((state) => {
      const next = { ...state.cardBySession };

      if (isSnapshot) {
        const present = new Set(updates.map((u) => u.sessionId));
        for (const sessionId of Object.keys(next)) {
          if (!present.has(sessionId)) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete next[sessionId];
          }
        }
      }

      if (removals) {
        for (const sessionId of removals) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete next[sessionId];
        }
      }

      for (const update of updates) {
        next[update.sessionId] = update;
      }

      return { cardBySession: next };
    });
  },

  dismiss: (sessionId) => {
    set((state) => {
      if (!state.cardBySession[sessionId]) return state;
      const next = { ...state.cardBySession };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete next[sessionId];
      return { cardBySession: next };
    });
  },

  reset: () => set(initialState),
}));
