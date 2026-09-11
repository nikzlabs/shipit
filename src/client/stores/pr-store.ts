import { create } from "zustand";
import type {
  AutoMergeManagedReason,
  PrStatusSummary,
  PrFileStat,
  PrIssueComment,
  PrReviewThread,
  PrReviewThreadComment,
  NotableFileChange,
} from "../../server/shared/types/github-types.js";
import { useSettingsStore } from "./settings-store.js";

interface ImportSearchResult {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface PrCardState {
  cardId: string;
  phase: "ready" | "creating" | "open" | "merged" | "closed" | "error";

  headBranch?: string;

  files?: PrFileStat[];
  totalInsertions?: number;
  totalDeletions?: number;

  pr?: {
    number: number;
    title: string;

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

  checks?: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;

    failedChecks?: { name: string; summary: string }[];

    graceUntil?: number;
  };

  autoFix?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number;
  };

  autoMerge?: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";

    managed?: boolean;
    /**
     * Why ShipIt owns it (docs/266). `native-unavailable` is a repo
     * misconfiguration and gets the settings tooltip; `session-live` and
     * `branch-unsynced` are normal waits and must NOT read as errors. Absent is
     * treated as `native-unavailable` (the only case before docs/266).
     */
    managedReason?: AutoMergeManagedReason;

    settingsUrl?: string;

    reason?: string;
    error?: { code: string; message: string; settingsUrl: string };
    /**
     * Which pull request this arming belongs to — client-side provenance, never
     * sent by the server. An arming is armed per PR (docs/077), so this is what
     * lets `selectActiveAutoMerge` tell a DEAD arming (its PR merged) from a
     * live pre-arm for the NEXT one, which looks identical otherwise.
     *
     * Stamped when the arming arrives on an open PR's summary, or when the user
     * toggles it while a PR is open. Left `undefined` for a pre-arm — armed
     * before any PR exists, or from a merged/closed card for the next one.
     */
    armedForPrNumber?: number;
  };

  autoResolve?: {
    status: "idle" | "running" | "deferred" | "exhausted";
    attemptCount: number;
    maxAttempts: number;
    lastError?: string;
    nextEligibleAt?: number;
  };

  issueComments?: PrIssueComment[];

  reviewThreads?: PrReviewThread[];

  previousMergedPr?: {
    number: number;
    url: string;
    title: string;
    baseBranch: string;
  };

  errorMessage?: string;

  errorKind?: "auth" | "generic";
}

interface PrState {

  statusBySession: Record<string, PrStatusSummary>;

  cardBySession: Record<string, PrCardState>;

  autoMergeBySession: Record<string, NonNullable<PrCardState["autoMerge"]>>;
  /**
   * docs/205/210 — sessionId → notable files (docs + allowlisted config +
   * images) changed across the whole PR, for the collapsible changed-docs strip.
   *
   * Kept in its OWN map rather than on the card because it's git-derived and
   * arrives on a different cadence/transport than the poller-driven card: at PR
   * creation and on each post-turn commit (`pr_notable_files`), plus a re-seed
   * when a viewer (re)connects (route-registry's `activateSession`). The poller's
   * `pr_status` snapshot — which rebuilds the card on reload/session-switch —
   * carries none of this, so holding it on the card meant a rebuild dropped the
   * doc chips until the next turn. A standalone slice survives card rebuilds and
   * doesn't depend on the card existing yet when a patch lands (the two travel on
   * independent sockets, with no ordering guarantee on first paint).
   */
  notableFilesBySession: Record<string, NotableFileChange[]>;

  /**
   * docs/218 — per-session "is this session reset-eligible right now?" signal
   * (merged + branch untouched since the merge + clean tree). Pushed transiently
   * via `reset_eligible` WS on session activation and post-turn. Drives the
   * composer's "start from the latest base" control visibility (ANDed with the
   * `autoResetMergedBranch` setting). Transient — never persisted; recomputed on
   * each (re)connect, so a stale value self-heals.
   */
  resetEligibleBySession: Record<string, boolean>;

  importSearchResults: ImportSearchResult[];

  applyPrStatusUpdates: (updates: PrStatusSummary[], removals?: string[], isSnapshot?: boolean) => void;

  updateCard: (sessionId: string, card: PrCardState) => void;

  setNotableFiles: (sessionId: string, cardId: string, notableFiles: NotableFileChange[]) => void;

  setResetEligible: (sessionId: string, eligible: boolean) => void;

  fixCI: (sessionId: string) => Promise<string | null>;

  postComment: (sessionId: string, body: string) => Promise<string | null>;

  replyToThread: (sessionId: string, threadId: string, body: string) => Promise<string | null>;

  resolveThread: (sessionId: string, threadId: string) => Promise<string | null>;

  unresolveThread: (sessionId: string, threadId: string) => Promise<string | null>;

  updatePr: (
    sessionId: string,
    changes: { title?: string; body?: string },
  ) => Promise<string | null>;

  merge: (sessionId: string, method?: string) => Promise<string | null>;

  closePr: (sessionId: string) => Promise<string | null>;

  toggleAutoMerge: (sessionId: string, enabled: boolean) => Promise<void>;

  setMergeMethod: (sessionId: string, method: "squash" | "merge" | "rebase") => Promise<void>;

  setImportSearchResults: (results: ImportSearchResult[]) => void;
  searchRepos: (query: string) => Promise<void>;

  reset: () => void;
}

const initialState = {
  statusBySession: {} as Record<string, PrStatusSummary>,
  cardBySession: {} as Record<string, PrCardState>,
  autoMergeBySession: {} as Record<string, NonNullable<PrCardState["autoMerge"]>>,
  notableFilesBySession: {} as Record<string, NotableFileChange[]>,
  resetEligibleBySession: {} as Record<string, boolean>,
  importSearchResults: [] as ImportSearchResult[],
};

export const usePrStore = create<PrState>((set, get) => ({
  ...initialState,

  applyPrStatusUpdates: (updates, removals, isSnapshot) => {
    set((state) => {
      const nextStatus = { ...state.statusBySession };
      const nextCards = { ...state.cardBySession };
      const nextAutoMerge = { ...state.autoMergeBySession };
      const nextNotable = { ...state.notableFilesBySession };

      if (isSnapshot) {
        const present = new Set(updates.map((u) => u.sessionId));
        for (const sessionId of Object.keys(nextStatus)) {
          if (!present.has(sessionId)) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete nextStatus[sessionId];
          }
        }
        for (const [sessionId, card] of Object.entries(nextCards)) {
          const pollerPhase = card.phase === "open" || card.phase === "merged" || card.phase === "closed";
          if (pollerPhase && !present.has(sessionId)) {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete nextCards[sessionId];

            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete nextNotable[sessionId];
          }
        }
      }

      if (removals) {
        for (const sessionId of removals) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextStatus[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextCards[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextAutoMerge[sessionId];
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextNotable[sessionId];
        }
      }

      for (const update of updates) {
        nextStatus[update.sessionId] = update;
        const isTerminal = update.prState === "merged" || update.prState === "closed";
        if (isTerminal) {

          // PR on this session inherits an arming the user never gave it.
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextAutoMerge[update.sessionId];
        } else if (update.autoMerge) {

          nextAutoMerge[update.sessionId] = {
            ...update.autoMerge,
            armedForPrNumber: update.prNumber,
          };
        }

        const existing = nextCards[update.sessionId];
        if (isTerminal) {
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

            // (see the clear above), so a terminal card must not resurrect it

            autoMerge: undefined,

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
            autoMerge: nextAutoMerge[update.sessionId] ?? update.autoMerge,
            ...(update.autoResolve !== undefined ? { autoResolve: update.autoResolve } : {}),

            issueComments: update.issueComments ?? existing?.issueComments,
            reviewThreads: update.reviewThreads ?? existing?.reviewThreads,
          };
        }
      }

      return {
        statusBySession: nextStatus,
        cardBySession: nextCards,
        autoMergeBySession: nextAutoMerge,
        notableFilesBySession: nextNotable,
      };
    });
  },

  updateCard: (sessionId, card) => {
    set((state) => {
      const existing = state.cardBySession[sessionId];

      // PR). It MUST be allowed to replace the stale terminal card, and order-

      // would race this card across transports), so this override is the sole

      if (existing && (existing.phase === "merged" || existing.phase === "closed") &&
          card.phase !== "merged" && card.phase !== "closed" &&
          !card.previousMergedPr) {
        return state;
      }

      // `lastKnown` *silently* (broadcasting `pr_status { removals }` would race

      // silent clear here converges without the racy removal.
      const reArmed = Boolean(card.previousMergedPr) && card.phase !== "merged" && card.phase !== "closed";
      let nextStatus = state.statusBySession;
      if (reArmed && state.statusBySession[sessionId]) {
        nextStatus = { ...state.statusBySession };
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete nextStatus[sessionId];
      }
      return {
        statusBySession: nextStatus,
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

  setNotableFiles: (sessionId, _cardId, notableFiles) => {
    set((state) => {
      const next = { ...state.notableFilesBySession };

      if (notableFiles.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete next[sessionId];
      } else {
        next[sessionId] = notableFiles;
      }
      return { notableFilesBySession: next };
    });
  },

  setResetEligible: (sessionId, eligible) => {
    set((state) => {

      const next = { ...state.resetEligibleBySession };
      if (eligible) {
        next[sessionId] = true;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete next[sessionId];
      }
      return { resetEligibleBySession: next };
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

      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to fix CI issues";
    }
  },

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

  closePr: async (sessionId) => {

    const prNumber =
      get().cardBySession[sessionId]?.pr?.number ?? get().statusBySession[sessionId]?.prNumber;
    if (!prNumber) return "No open pull request to close";
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pr/${prNumber}/close`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        return data.error || data.message || "Failed to close pull request";
      }

      set((state) => {
        const existing = state.cardBySession[sessionId];
        if (!existing) return state;
        return {
          cardBySession: {
            ...state.cardBySession,
            [sessionId]: { ...existing, phase: "closed" as const },
          },
        };
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to close pull request";
    }
  },

  toggleAutoMerge: async (sessionId, enabled) => {

    const prevAutoMerge = get().autoMergeBySession[sessionId];
    const prevCardAutoMerge = get().cardBySession[sessionId]?.autoMerge;

    const armedForPrNumber = livePrNumber(get(), sessionId);

    set((state) => {
      const existing = state.cardBySession[sessionId];
      const base = selectActiveAutoMerge(state, sessionId)
        ?? { enabled: false, mergeMethod: "squash" as const };

      const optimistic = { ...base, enabled, armedForPrNumber };
      return {
        autoMergeBySession: {
          ...state.autoMergeBySession,
          [sessionId]: optimistic,
        },
        cardBySession: {
          ...state.cardBySession,
          ...(existing ? { [sessionId]: { ...existing, autoMerge: optimistic } } : {}),
        },
      };
    });

    const revert = () => {
      set((state) => {
        const existing = state.cardBySession[sessionId];
        const nextAutoMerge = { ...state.autoMergeBySession };
        if (prevAutoMerge) {
          nextAutoMerge[sessionId] = prevAutoMerge;
        } else {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete nextAutoMerge[sessionId];
        }
        return {
          autoMergeBySession: nextAutoMerge,
          cardBySession: {
            ...state.cardBySession,
            ...(existing ? { [sessionId]: { ...existing, autoMerge: prevCardAutoMerge } } : {}),
          },
        };
      });
    };

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
        const data = await res.json().catch(() => ({})) as { error?: string };
        console.error("[pr-store] Auto-merge toggle failed:", data.error);
        revert();
        return;
      }
      const data = await res.json() as {
        enabled: boolean;
        mergeMethod: "squash" | "merge" | "rebase";
        managed?: boolean;
        managedReason?: AutoMergeManagedReason;
        reason?: string;
      };
      set((state) => {
        const existing = state.cardBySession[sessionId];

        if (armedForPrNumber !== undefined && isPrTerminal(state, sessionId)) {
          const cleared = { ...state.autoMergeBySession };
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete cleared[sessionId];
          return {
            autoMergeBySession: cleared,
            cardBySession: {
              ...state.cardBySession,
              ...(existing ? { [sessionId]: { ...existing, autoMerge: undefined } } : {}),
            },
          };
        }
        const autoMerge = {
          ...state.autoMergeBySession[sessionId],
          enabled: data.enabled,
          mergeMethod: data.mergeMethod,
          managed: data.managed,

          // managed-because-live arming would flash the repo-misconfiguration

          managedReason: data.managedReason,
          reason: data.reason,

          armedForPrNumber,
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
      revert();
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

    } catch (err) {
      console.error("[pr-store] Set merge method failed:", err);
    }
  },

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

/**
 * True when the session's CURRENT pull request has reached a terminal state
 * (merged, or closed without merging).
 *
 * Reads BOTH halves of the model because they converge on different transports:
 * the card phase is what the inline card renders, `statusBySession.prState` is
 * the poller's own last word. Either saying "terminal" is enough — an arming
 * that outlives its PR must not be rendered because one channel lagged.
 */
export function isPrTerminal(state: PrState, sessionId: string): boolean {
  const phase = state.cardBySession[sessionId]?.phase;
  if (phase === "merged" || phase === "closed") return true;
  const prState = state.statusBySession[sessionId]?.prState;
  return prState === "merged" || prState === "closed";
}

function livePrNumber(state: PrState, sessionId: string): number | undefined {
  if (isPrTerminal(state, sessionId)) return undefined;
  return state.cardBySession[sessionId]?.pr?.number ?? state.statusBySession[sessionId]?.prNumber;
}

/**
 * The auto-merge arming that can still act on this session — the arming for the
 * PR that is currently open, or a pre-arm waiting for the next PR to exist.
 *
 * Every surface that renders "auto-merge is on" (sidebar badge, PR overflow
 * toggle, open card, detail panel) reads THIS rather than the raw maps, so the
 * rule that an arming dies with its pull request (docs/077) holds by
 * construction instead of depending on the terminal `pr_status` update being
 * observed. Missing that one event used to strand the toggle ON forever.
 *
 * Provenance, not phase, is what decides: hiding every arming on a terminal card
 * would also hide a deliberate pre-arm for the NEXT PR, which is a real flow (a
 * merged session picking up new work never passes back through `ready` when
 * auto-create-PR is on — `pr-lifecycle.ts` goes creating → open). So an arming
 * stamped for a PR that is no longer the live one is dead; an unstamped one is a
 * pre-arm and survives.
 *
 * Returns `undefined` — never a fresh object — so the zustand subscription
 * stays reference-stable.
 */
export function selectActiveAutoMerge(
  state: PrState,
  sessionId: string,
): NonNullable<PrCardState["autoMerge"]> | undefined {
  const arming = state.autoMergeBySession[sessionId] ?? state.cardBySession[sessionId]?.autoMerge;
  if (!arming) return undefined;
  if (arming.armedForPrNumber === undefined) return arming;
  return arming.armedForPrNumber === livePrNumber(state, sessionId) ? arming : undefined;
}

export function useActiveAutoMerge(
  sessionId: string,
): NonNullable<PrCardState["autoMerge"]> | undefined {
  return usePrStore((s) => selectActiveAutoMerge(s, sessionId));
}
