import { create } from "zustand";
import type {
  PrStatusSummary,
  PrFileStat,
  PrIssueComment,
  PrReviewThread,
  PrReviewThreadComment,
} from "../../server/shared/types/github-types.js";
import { useSettingsStore } from "./settings-store.js";

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
    createdAt?: string;
    author?: { login: string; avatarUrl: string };
    url: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    files?: PrFileStat[];
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
  /**
   * PR-level (issue) comments — docs/133 Phase 4. Only populated while the PR
   * tab is open (the poller gates the fetch); `undefined` means "not fetched".
   */
  issueComments?: PrIssueComment[];
  /** Review threads (line comments) — docs/133 Phase 4, read-only. */
  reviewThreads?: PrReviewThread[];
  /** Error message (error phase). */
  errorMessage?: string;
  /**
   * Classification of the error (error phase). "auth" means the GitHub token
   * is missing/expired and the user should reconnect — the card surfaces a
   * "Sign in to GitHub" action alongside Retry. Defaults to a generic error
   * with only Retry.
   */
  errorKind?: "auth" | "generic";
}

interface PrState {
  // ---- PR lifecycle card state (SSE-driven) ----
  /** sessionId → PrStatusSummary from the poller. */
  statusBySession: Record<string, PrStatusSummary>;
  /** sessionId → PrCardState for inline card rendering. */
  cardBySession: Record<string, PrCardState>;
  /** sessionId → auto-merge preference/state, available before a PR card exists. */
  autoMergeBySession: Record<string, NonNullable<PrCardState["autoMerge"]>>;

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

  // CI fix actions
  /** Trigger manual CI fix. Returns error message on failure, null on success. */
  fixCI: (sessionId: string) => Promise<string | null>;
  /** Toggle auto-fix on/off. */
  toggleAutoFix: (sessionId: string, enabled: boolean) => Promise<void>;

  // Conversation actions (docs/133 Phase 4)
  /**
   * Post a PR-level (issue) comment. Optimistically appends it to the card so
   * the user sees it immediately, then reconciles on the next poll. Returns an
   * error message on failure (after reverting the optimistic append), null on
   * success.
   */
  postComment: (sessionId: string, body: string) => Promise<string | null>;

  // Review-thread sync actions (docs/102)
  /**
   * Reply to a PR review thread. Optimistically appends the reply to the
   * matching thread on the card and reconciles on the next poll. Returns an
   * error message on failure (after reverting), null on success.
   */
  replyToThread: (sessionId: string, threadId: string, body: string) => Promise<string | null>;
  /**
   * Mark a PR review thread as resolved. Optimistically flips `isResolved`
   * on the card and reconciles on the next poll. Returns an error message
   * on failure (after reverting), null on success.
   */
  resolveThread: (sessionId: string, threadId: string) => Promise<string | null>;
  /**
   * Reopen a previously-resolved PR review thread. Same optimistic + revert
   * pattern as `resolveThread`.
   */
  unresolveThread: (sessionId: string, threadId: string) => Promise<string | null>;

  // PR edit actions (docs/133 Phase 2)
  /**
   * Edit the PR title and/or body. Optimistically updates the card so the
   * change shows immediately, then reconciles on the next poll. Reverts the
   * optimistic change and returns an error message on failure; null on success.
   */
  updatePr: (
    sessionId: string,
    changes: { title?: string; body?: string },
  ) => Promise<string | null>;

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
  autoMergeBySession: {} as Record<string, NonNullable<PrCardState["autoMerge"]>>,
  importSearchResults: [] as ImportSearchResult[],
};

export const usePrStore = create<PrState>((set, get) => ({
  ...initialState,

  // ---- SSE-driven actions ----

  applyPrStatusUpdates: (updates, removals) => {
    set((state) => {
      const nextStatus = { ...state.statusBySession };
      const nextCards = { ...state.cardBySession };
      const nextAutoMerge = { ...state.autoMergeBySession };

      if (removals) {
        for (const sessionId of removals) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextStatus[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextCards[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextAutoMerge[sessionId];
        }
      }

      for (const update of updates) {
        nextStatus[update.sessionId] = update;
        if (update.autoMerge) {
          nextAutoMerge[update.sessionId] = update.autoMerge;
        }

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
              createdAt: update.prCreatedAt,
              author: update.prAuthor,
              url: update.prUrl,
              baseBranch: update.baseBranch,
              headBranch: update.headBranch,
              insertions: update.insertions,
              deletions: update.deletions,
              files: update.files,
            },
            autoMerge: update.autoMerge ?? nextAutoMerge[update.sessionId],
            // Preserve last-known conversation when an update omits it (light poll).
            issueComments: update.issueComments ?? existing?.issueComments,
            reviewThreads: update.reviewThreads ?? existing?.reviewThreads,
          };
        } else {
          nextCards[update.sessionId] = {
            cardId: existing?.cardId ?? `pr-card-${update.sessionId}`,
            phase: "open",
            pr: {
              number: update.prNumber,
              title: update.prTitle,
              body: update.prBody,
              createdAt: update.prCreatedAt,
              author: update.prAuthor,
              url: update.prUrl,
              baseBranch: update.baseBranch,
              headBranch: update.headBranch,
              insertions: update.insertions,
              deletions: update.deletions,
              files: update.files,
            },
            checks: update.checks,
            autoFix: update.autoFix,
            autoMerge: update.autoMerge ?? nextAutoMerge[update.sessionId],
            // Preserve last-known conversation when an update omits it (light poll).
            issueComments: update.issueComments ?? existing?.issueComments,
            reviewThreads: update.reviewThreads ?? existing?.reviewThreads,
          };
        }
      }

      return { statusBySession: nextStatus, cardBySession: nextCards, autoMergeBySession: nextAutoMerge };
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
      return {
        autoMergeBySession: card.autoMerge
          ? { ...state.autoMergeBySession, [sessionId]: card.autoMerge }
          : state.autoMergeBySession,
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...card,
            autoMerge: card.autoMerge ?? existing?.autoMerge ?? state.autoMergeBySession[sessionId],
          },
        },
      };
    });
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

  // ---- Conversation actions (docs/133 Phase 4) ----

  postComment: async (sessionId, body) => {
    const trimmed = body.trim();
    if (!trimmed) return "Comment cannot be empty";

    const ghUser = useSettingsStore.getState().githubStatus;
    const optimisticId = `optimistic-${Date.now()}`;
    const optimistic: PrIssueComment = {
      id: optimisticId,
      author: { login: ghUser.username ?? "you", avatarUrl: ghUser.avatarUrl ?? "" },
      body: trimmed,
      createdAt: new Date().toISOString(),
      url: "",
    };

    // Optimistically append so the comment shows immediately; the next poll
    // tick reconciles with GitHub's authoritative copy.
    set((state) => {
      const existing = state.cardBySession[sessionId];
      if (!existing) return state;
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            issueComments: [...(existing.issueComments ?? []), optimistic],
          },
        },
      };
    });

    const revert = () => {
      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing?.issueComments) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: {
              ...existing,
              issueComments: existing.issueComments.filter((c) => c.id !== optimisticId),
            },
          },
        };
      });
    };

    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/comments`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        revert();
        return data.error || "Failed to post comment";
      }
      return null;
    } catch (err) {
      revert();
      return err instanceof Error ? err.message : "Failed to post comment";
    }
  },

  // ---- Review-thread sync actions (docs/102) ----
  //
  // All three follow the same pattern as `postComment`: optimistically mutate
  // the matching thread on the card, fire the HTTP call, revert on failure.
  // The next poll tick (5s by default) reconciles with GitHub's authoritative
  // state, so success doesn't need to overwrite anything — leaving the
  // optimistic copy in place avoids a flicker.

  replyToThread: async (sessionId, threadId, body) => {
    const trimmed = body.trim();
    if (!trimmed) return "Reply cannot be empty";

    const ghUser = useSettingsStore.getState().githubStatus;
    const optimisticId = `optimistic-reply-${Date.now()}`;
    const optimisticComment: PrReviewThreadComment = {
      id: optimisticId,
      author: { login: ghUser.username ?? "you", avatarUrl: ghUser.avatarUrl ?? "" },
      body: trimmed,
      createdAt: new Date().toISOString(),
    };

    let snapshot: PrReviewThread[] | undefined;
    set((state) => {
      const existing = state.cardBySession[sessionId];
      if (!existing?.reviewThreads) return state;
      snapshot = existing.reviewThreads;
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            reviewThreads: existing.reviewThreads.map((t) =>
              t.id === threadId ? { ...t, comments: [...t.comments, optimisticComment] } : t,
            ),
          },
        },
      };
    });

    const revert = () => {
      if (!snapshot) return;
      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: { ...existing, reviewThreads: snapshot },
          },
        };
      });
    };

    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/pr/threads/${encodeURIComponent(threadId)}/reply`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: trimmed }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        revert();
        return data.error || "Failed to post reply";
      }
      return null;
    } catch (err) {
      revert();
      return err instanceof Error ? err.message : "Failed to post reply";
    }
  },

  resolveThread: async (sessionId, threadId) => {
    let snapshot: PrReviewThread[] | undefined;
    set((state) => {
      const existing = state.cardBySession[sessionId];
      if (!existing?.reviewThreads) return state;
      snapshot = existing.reviewThreads;
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            reviewThreads: existing.reviewThreads.map((t) =>
              t.id === threadId ? { ...t, isResolved: true } : t,
            ),
          },
        },
      };
    });

    const revert = () => {
      if (!snapshot) return;
      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: { ...existing, reviewThreads: snapshot },
          },
        };
      });
    };

    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/pr/threads/${encodeURIComponent(threadId)}/resolve`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        revert();
        return data.error || "Failed to resolve thread";
      }
      return null;
    } catch (err) {
      revert();
      return err instanceof Error ? err.message : "Failed to resolve thread";
    }
  },

  unresolveThread: async (sessionId, threadId) => {
    let snapshot: PrReviewThread[] | undefined;
    set((state) => {
      const existing = state.cardBySession[sessionId];
      if (!existing?.reviewThreads) return state;
      snapshot = existing.reviewThreads;
      return {
        cardBySession: {
          ...state.cardBySession,
          [sessionId]: {
            ...existing,
            reviewThreads: existing.reviewThreads.map((t) =>
              t.id === threadId ? { ...t, isResolved: false } : t,
            ),
          },
        },
      };
    });

    const revert = () => {
      if (!snapshot) return;
      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: { ...existing, reviewThreads: snapshot },
          },
        };
      });
    };

    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/pr/threads/${encodeURIComponent(threadId)}/unresolve`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        revert();
        return data.error || "Failed to reopen thread";
      }
      return null;
    } catch (err) {
      revert();
      return err instanceof Error ? err.message : "Failed to reopen thread";
    }
  },

  // ---- PR edit actions (docs/133 Phase 2) ----

  updatePr: async (sessionId, changes) => {
    const card = get().cardBySession[sessionId];
    if (!card?.pr) return "No pull request to update";
    if (typeof changes.title !== "string" && typeof changes.body !== "string") {
      return "Provide a title or body to update";
    }
    const prNumber = card.pr.number;
    const prev = { title: card.pr.title, body: card.pr.body };

    const applyPr = (pr: NonNullable<PrCardState["pr"]>) => {
      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing?.pr) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: { ...existing, pr },
          },
        };
      });
    };

    // Optimistically apply the edit so it shows immediately; the next poll
    // reconciles with GitHub's authoritative copy.
    applyPr({
      ...card.pr,
      ...(typeof changes.title === "string" ? { title: changes.title } : {}),
      ...(typeof changes.body === "string" ? { body: changes.body } : {}),
    });

    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/${prNumber}`, {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        // Revert to the pre-edit title/body.
        const current = get().cardBySession[sessionId];
        if (current?.pr) applyPr({ ...current.pr, title: prev.title, body: prev.body });
        return data.error || "Failed to update pull request";
      }
      return null;
    } catch (err) {
      const current = get().cardBySession[sessionId];
      if (current?.pr) applyPr({ ...current.pr, title: prev.title, body: prev.body });
      return err instanceof Error ? err.message : "Failed to update pull request";
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
        return;
      }
      const data = await res.json() as { enabled: boolean; mergeMethod: "squash" | "merge" | "rebase"; managed?: boolean };
      set((state) => {
        const existing = state.cardBySession[sessionId];
        const autoMerge = {
          ...state.autoMergeBySession[sessionId],
          enabled: data.enabled,
          mergeMethod: data.mergeMethod,
          managed: data.managed,
        };
        return {
          autoMergeBySession: {
            ...state.autoMergeBySession,
            [sessionId]: autoMerge,
          },
          cardBySession: {
            ...state.cardBySession,
            ...(existing ? { [sessionId]: { ...existing, autoMerge } } : {}),
          },
        };
      });
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
