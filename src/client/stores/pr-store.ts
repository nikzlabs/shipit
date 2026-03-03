import { create } from "zustand";
import type { PrStatusSummary, PrFileStat } from "../../server/shared/types/github-types.js";

// ---- Types ----

interface PrResult {
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
}

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
  phase: "ready" | "creating" | "open" | "merged" | "error";
  /** Files changed (ready phase). */
  files?: PrFileStat[];
  totalInsertions?: number;
  totalDeletions?: number;
  /** PR info (open/merged phases). */
  pr?: {
    number: number;
    title: string;
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

  // ---- Legacy modal state (kept for "Create with options..." escape hatch) ----
  showModal: boolean;
  currentBranch: string;
  remoteBranches: string[];
  result: PrResult | null;
  descGenerating: boolean;
  descError: string | null;
  generatedDesc: string | null;
  importSearchResults: ImportSearchResult[];

  // SSE-driven actions
  /** Bulk update from pr_status SSE event. */
  applyPrStatusUpdates: (updates: PrStatusSummary[]) => void;
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

  // Legacy modal actions
  openModal: () => void;
  closeModal: () => void;
  setResult: (result: PrResult | null) => void;
  setImportSearchResults: (results: ImportSearchResult[]) => void;
  setCurrentBranch: (branch: string) => void;
  setRemoteBranches: (branches: string[]) => void;
  setDescGenerating: (generating: boolean) => void;
  setDescError: (error: string | null) => void;
  setGeneratedDesc: (desc: string | null) => void;
  reset: () => void;

  // Legacy async actions (kept for modal + sidebar)
  submit: (
    sessionId: string,
    data: { title: string; body: string; base: string; draft: boolean },
  ) => Promise<void>;
  requestBranches: (sessionId: string) => Promise<void>;
  generateDescription: (sessionId: string) => Promise<void>;
  searchRepos: (query: string) => Promise<void>;
  mergePr: (
    sessionId: string,
    method: "merge" | "squash" | "rebase",
  ) => Promise<{ success: boolean; autoMergeEnabled?: boolean } | null>;
  fetchStatus: (sessionId: string) => Promise<void>;
}

const initialState = {
  statusBySession: {} as Record<string, PrStatusSummary>,
  cardBySession: {} as Record<string, PrCardState>,
  showModal: false,
  currentBranch: "",
  remoteBranches: [] as string[],
  result: null as PrResult | null,
  descGenerating: false,
  descError: null as string | null,
  generatedDesc: null as string | null,
  importSearchResults: [] as ImportSearchResult[],
};

export const usePrStore = create<PrState>((set, get) => ({
  ...initialState,

  // ---- SSE-driven actions ----

  applyPrStatusUpdates: (updates) => {
    set((state) => {
      const nextStatus = { ...state.statusBySession };
      const nextCards = { ...state.cardBySession };

      for (const update of updates) {
        nextStatus[update.sessionId] = update;

        // Update the inline card to reflect poller data
        const existing = nextCards[update.sessionId];
        if (update.prState === "merged") {
          nextCards[update.sessionId] = {
            cardId: existing?.cardId ?? `pr-card-${update.sessionId}`,
            phase: "merged",
            pr: {
              number: update.prNumber,
              title: update.prTitle,
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
              url: update.prUrl,
              baseBranch: update.baseBranch,
              headBranch: update.headBranch,
              insertions: update.insertions,
              deletions: update.deletions,
            },
            checks: update.checks,
          };
        }
      }

      return { statusBySession: nextStatus, cardBySession: nextCards };
    });
  },

  updateCard: (sessionId, card) => {
    set((state) => ({
      cardBySession: { ...state.cardBySession, [sessionId]: card },
    }));
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
        const data = await res.json();
        get().setCardError(sessionId, data.error || "Failed to create pull request");
        return;
      }
      const data = await res.json();
      get().setCardOpen(sessionId, {
        number: data.number,
        title: data.title,
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

  // ---- Legacy modal actions ----

  openModal: () =>
    set({
      result: null,
      currentBranch: "",
      remoteBranches: [],
      descGenerating: false,
      descError: null,
      generatedDesc: null,
      showModal: true,
    }),

  closeModal: () => set({ showModal: false }),

  setResult: (result) => set({ result }),

  setImportSearchResults: (importSearchResults) => set({ importSearchResults }),

  setCurrentBranch: (currentBranch) => set({ currentBranch }),

  setRemoteBranches: (remoteBranches) => set({ remoteBranches }),

  setDescGenerating: (descGenerating) => set({ descGenerating }),

  setDescError: (descError) => set({ descError }),

  setGeneratedDesc: (generatedDesc) => set({ generatedDesc }),

  reset: () => set(initialState),

  submit: async (sessionId, data) => {
    const res = await fetch(`/api/sessions/${sessionId}/pr`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    set({ result: json });
  },

  requestBranches: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/git/branches`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    set({
      currentBranch: data.current,
      remoteBranches: data.remote,
    });
  },

  generateDescription: async (sessionId) => {
    set({ descGenerating: true, descError: null, generatedDesc: null });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/description`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
      const data = await res.json();
      if (!res.ok) {
        set({ descError: data.error || "Failed to generate description" });
      } else {
        set({ generatedDesc: data.description });
      }
    } catch (err) {
      set({
        descError:
          err instanceof Error ? err.message : "Failed to generate description",
      });
    } finally {
      set({ descGenerating: false });
    }
  },

  searchRepos: async (query) => {
    const res = await fetch(
      `/api/github/repos?q=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );
    const data = await res.json();
    set({ importSearchResults: data.repos });
  },

  mergePr: async (sessionId, method) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/merge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ method }),
      });
      const data = await res.json();
      return data;
    } catch {
      return null;
    }
  },

  fetchStatus: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/pr/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const data = await res.json();
    if (data.pr) {
      set((state) => ({
        statusBySession: {
          ...state.statusBySession,
          [sessionId]: {
            sessionId,
            prNumber: data.pr.number,
            prUrl: data.pr.url,
            prTitle: data.pr.title,
            prState: "open" as const,
            baseBranch: data.pr.baseBranch,
            headBranch: data.pr.headBranch,
            insertions: data.pr.insertions,
            deletions: data.pr.deletions,
            checks: data.pr.checks,
            mergeable: data.pr.mergeable,
            autoMergeEnabled: data.pr.autoMergeEnabled,
          },
        },
      }));
    }
  },
}));
