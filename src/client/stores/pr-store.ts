import { create } from "zustand";
import type { PrStatusSummary, PrFileStat } from "../../server/shared/types/github-types.js";

// ---- Types ----

interface ImportSearchResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

/** PR lifecycle card state for a single session. */
export interface PrCardState {
  cardId: string;
  phase: "ready" | "creating" | "open" | "merged" | "closed" | "error";
  /** Current branch name (ready phase). */
  headBranch?: string;
  /** Files changed (ready phase). */
  files?: PrFileStat[];
  totalInsertions?: number;
  totalDeletions?: number;
  /** PR info (open/merged phases). */
  pr?: {
    number: number;
    title: string;
    /** PR description body (markdown source). Optional; omitted when none. */
    body?: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
  };
  /** CI check status (open phase). */
  checks?: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
    /** Per-check failure details. */
    failedChecks?: { name: string; summary: string }[];
  };
  /** Auto-fix state (open phase). */
  autoFix?: {
    enabled: boolean;
    status: "idle" | "running" | "exhausted";
    attemptCount: number;
    maxAttempts: number;
  };
  /** Auto-merge state (open phase). */
  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    /** True when ShipIt manages the merge (GitHub native unavailable). */
    managed?: boolean;
    /** GitHub settings URL for configuring branch protection. */
    settingsUrl?: string;
    error?: { code: string; message: string; settingsUrl: string };
  };
  /** Error message (error phase). */
  errorMessage?: string;
}

interface PrState {
  // ---- PR lifecycle card state (SSE-driven) ----
  /** sessionId → PrStatusSummary from the poller. */
  statusBySession: Record<string, PrStatusSummary>;
  /** sessionId → PrCardState for inline card rendering. */
  cardBySession: Record<string, PrCardState>;

  // Repo import search (used by home page repo picker)
  importSearchResults: ImportSearchResult[];

  // SSE-driven actions
  /**
   * Bulk update from pr_status SSE event. `removals` contains session IDs
   * whose PR snapshot was cleared on the server (e.g., on unarchive — the
   * session starts a fresh branch, so the previous PR no longer applies).
   */
  applyPrStatusUpdates: (updates: PrStatusSummary[], removals?: string[]) => void;
  /** Update inline card from pr_lifecycle_update WS message. */
  updateCard: (sessionId: string, card: PrCardState) => void;
  /** Set card to "creating" phase. */
  setCardCreating: (sessionId: string) => void;
  /** Set card to "open" phase from quick-create response. */
  setCardOpen: (sessionId: string, pr: PrCardState["pr"]) => void;
  /** Set card to "error" phase. */
  setCardError: (sessionId: string, message: string) => void;

  // Quick PR creation
  quickCreate: (sessionId: string) => Promise<void>;

  // CI fix actions
  /** Trigger manual CI fix. Returns error message on failure, null on success. */
  fixCI: (sessionId: string) => Promise<string | null>;
  /** Toggle auto-fix on/off. */
  toggleAutoFix: (sessionId: string, enabled: boolean) => Promise<void>;

  // Merge actions
  /** Merge the PR with the given method. Returns error message on failure, null on success. */
  merge: (sessionId: string, method?: string) => Promise<string | null>;
  /** Toggle auto-merge on/off. */
  toggleAutoMerge: (sessionId: string, enabled: boolean) => Promise<void>;
  /** Update the preferred merge method. */
  setMergeMethod: (sessionId: string, method: "squash" | "merge" | "rebase") => Promise<void>;

  // Repo import actions
  setImportSearchResults: (results: ImportSearchResult[]) => void;
  searchRepos: (query: string) => Promise<void>;

  // Reset
  reset: () => void;
}

const initialState = {
  statusBySession: {} as Record<string, PrStatusSummary>,
  cardBySession: {} as Record<string, PrCardState>,
  importSearchResults: [] as ImportSearchResult[],
};

export const usePrStore = create<PrState>((set, get) => ({
  ...initialState,

  // ---- SSE-driven actions ----

  applyPrStatusUpdates: (updates, removals) => {
    set((state) => {
      const nextStatus = { ...state.statusBySession };
      const nextCards = { ...state.cardBySession };

      if (removals) {
        for (const sessionId of removals) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextStatus[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextCards[sessionId];
        }
      }

      for (const update of updates) {
        nextStatus[update.sessionId] = update;

        // Update the inline card to reflect poller data
        const existing = nextCards[update.sessionId];
        if (update.prState === "merged" || update.prState === "closed") {
          nextCards[update.sessionId] = {
            cardId: existing?.cardId ?? `pr-card-${update.sessionId}`,
            phase: update.prState,
            pr: {
              number: update.prNumber,
              title: update.prTitle,
              body: update.prBody,
              url: update.prUrl,
              baseBranch: update.baseBranch,
              headBranch: update.headBranch,
              insertions: update.insertions,
              deletions: update.deletions,
            },
          };
        } else {
          nextCards[update.sessionId] = {
            cardId: existing?.cardId ?? `pr-card-${update.sessionId}`,
            phase: "open",
            pr: {
              number: update.prNumber,
              title: update.prTitle,
              body: update.prBody,
              url: update.prUrl,
              baseBranch: update.baseBranch,
              headBranch: update.headBranch,
              insertions: update.insertions,
              deletions: update.deletions,
            },
            checks: update.checks,
            autoFix: update.autoFix,
            autoMerge: update.autoMerge,
          };
        }
      }

      return { statusBySession: nextStatus, cardBySession: nextCards };
    });
  },

  updateCard: (sessionId, card) => {
    set((state) => {
      const existing = state.cardBySession[sessionId];
      // Don't regress from terminal phases (merged/closed) — SSE poller is authoritative
      if (existing && (existing.phase === "merged" || existing.phase === "closed") &&
          card.phase !== "merged" && card.phase !== "closed") {
        return state;
      }
      return { cardBySession: { ...state.cardBySession, [sessionId]: card } };
    });
  },

  setCardCreating: (sessionId) => {
    set((state) => {
      const existing = state.cardBySession[sessionId];
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            cardId: existing?.cardId ?? `pr-card-${sessionId}`,
            phase: "creating" as const,
          },
        },
      };
    });
  },

  setCardOpen: (sessionId, pr) => {
    set((state) => ({
      cardBySession: {
        ...state.cardBySession,
        [sessionId]: {
          cardId: state.cardBySession[sessionId]?.cardId ?? `pr-card-${sessionId}`,
          phase: "open" as const,
          pr,
        },
      },
    }));
  },

  setCardError: (sessionId, message) => {
    set((state) => {
      const existing = state.cardBySession[sessionId];
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            cardId: existing?.cardId ?? `pr-card-${sessionId}`,
            phase: "error" as const,
            errorMessage: message,
          },
        },
      };
    });
  },

  quickCreate: async (sessionId) => {
    get().setCardCreating(sessionId);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/quick`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        get().setCardError(sessionId, data.error || "Failed to create pull request");
        return;
      }
      const data = await res.json() as { number: number; title: string; body?: string; url: string; baseBranch: string; headBranch: string; insertions: number; deletions: number };
      get().setCardOpen(sessionId, {
        number: data.number,
        title: data.title,
        body: data.body,
        url: data.url,
        baseBranch: data.baseBranch,
        headBranch: data.headBranch,
        insertions: data.insertions,
        deletions: data.deletions,
      });
    } catch (err) {
      get().setCardError(
        sessionId,
        err instanceof Error ? err.message : "Failed to create pull request",
      );
    }
  },

  fixCI: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/fix-ci`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        return data.error || "Failed to fix CI issues";
      }
      // State updates come from SSE, not from the POST response
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to fix CI issues";
    }
  },

  toggleAutoFix: async (sessionId, enabled) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/auto-fix`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        console.error("[pr-store] Auto-fix toggle failed:", data.error);
      }
      // State updates come from SSE, not from the POST response
    } catch (err) {
      console.error("[pr-store] Auto-fix toggle failed:", err);
    }
  },

  // ---- Merge actions ----

  merge: async (sessionId, method) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/merge`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method }),
      });
      if (!res.ok) {
        const data = await res.json() as { message?: string; error?: string };
        return data.message || data.error || "Failed to merge pull request";
      }
      const data = await res.json() as { success: boolean; message: string; autoMergeEnabled?: boolean };
      if (!data.success) {
        return data.message || "Failed to merge pull request";
      }
      // Optimistically update card phase so the button disappears immediately
      // instead of waiting for SSE poller to detect the merge.
      if (!data.autoMergeEnabled) {
        set((state) => {
          const existing = state.cardBySession[sessionId];
          if (!existing) return state;
          return {
            cardBySession: {
              ...state.cardBySession,
              [sessionId]: { ...existing, phase: "merged" as const },
            },
          };
        });
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to merge pull request";
    }
  },

  toggleAutoMerge: async (sessionId, enabled) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/auto-merge`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        console.error("[pr-store] Auto-merge toggle failed:", data.error);
      }
      // State updates come from SSE
    } catch (err) {
      console.error("[pr-store] Auto-merge toggle failed:", err);
    }
  },

  setMergeMethod: async (sessionId, method) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/merge-method`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        console.error("[pr-store] Set merge method failed:", data.error);
      }
      // State updates come from SSE
    } catch (err) {
      console.error("[pr-store] Set merge method failed:", err);
    }
  },

  // ---- Repo import actions ----

  setImportSearchResults: (importSearchResults) => set({ importSearchResults }),

  reset: () => set(initialState),

  searchRepos: async (query) => {
    const res = await fetch(
      `/api/github/repos?q=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
    const data = await res.json() as { repos: ImportSearchResult[] };
    set({ importSearchResults: data.repos });
  },
}));
