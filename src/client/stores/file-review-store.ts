/**
 * File-review store — server-persisted review drafts for the unified review
 * surface (docs/112-unified-review-surface).
 *
 * One draft per (session, filePath) lives on the server. This store mirrors
 * the active draft and the per-file history client-side, and exposes actions
 * that delegate to the HTTP API. Components read state via Zustand selectors;
 * mutations always round-trip through the server so reloads and reconnects
 * see the same data.
 */

import { create } from "zustand";
import type { FileReview, ReviewComment } from "../../server/shared/types.js";

function makeKey(sessionId: string, filePath: string): string {
  return `${sessionId}::${filePath}`;
}

/** Return a copy of `obj` with `key` removed. Used in place of `delete obj[key]`
 *  to keep the store immutable and dodge the no-dynamic-delete lint rule. */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const { [key]: _omitted, ...rest } = obj;
  return rest;
}

class FileReviewApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "Accept": "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch { /* ignore */ }
    throw new FileReviewApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

interface FileReviewState {
  /** Current draft for each (session, file) we've opened. */
  draftByKey: Record<string, FileReview | null>;
  /** Sent-review history for each (session, file). */
  historyByKey: Record<string, FileReview[]>;
  /** True while AI Review is in flight for the given key. */
  aiLoadingByKey: Record<string, boolean>;
  /**
   * Streaming partial text from the in-flight AI Review run, keyed by
   * (session, file) so the modal can render a live "thinking…" panel
   * while the agent is producing output. Cleared on completion.
   */
  aiProgressByKey: Record<string, string>;
  /** True while the initial draft is being loaded for the given key. */
  loadingByKey: Record<string, boolean>;

  /** Load (or create) the draft + history for a (session, file). */
  load: (sessionId: string, filePath: string) => Promise<FileReview | null>;

  /** Add a line-anchored comment. Only valid for code reviews. */
  addLineComment: (
    sessionId: string,
    filePath: string,
    line: number,
    text: string,
  ) => Promise<ReviewComment | null>;

  /** Add a section-anchored comment. Only valid for markdown reviews. */
  addSectionComment: (
    sessionId: string,
    filePath: string,
    sectionHeading: string,
    sectionIndex: number,
    text: string,
  ) => Promise<ReviewComment | null>;

  /** Update a comment's text. */
  editComment: (
    sessionId: string,
    filePath: string,
    commentId: string,
    text: string,
  ) => Promise<void>;

  /** Delete a comment. */
  deleteComment: (
    sessionId: string,
    filePath: string,
    commentId: string,
  ) => Promise<void>;

  /** Run AI Review on the current draft (markdown only). */
  aiReview: (sessionId: string, filePath: string) => Promise<ReviewComment[]>;

  /**
   * Send the draft. Marks it sent, returns the constructed prompt, moves the
   * sent review into history, and clears the draft locally so the modal can
   * fetch a fresh one on next open.
   */
  sendDraft: (sessionId: string, filePath: string) => Promise<string | null>;

  /**
   * Discard an empty draft. Called when the user closes the modal without
   * leaving any comments — keeps the database tidy.
   */
  discardEmptyDraft: (sessionId: string, filePath: string) => Promise<void>;

  /**
   * Push streaming partial text from an in-flight AI Review run. Called
   * from the per-session WebSocket dispatcher when an `ai_review_progress`
   * message arrives. The reviewId is matched against the currently-loaded
   * drafts to find the (session, file) key — events for stale review IDs
   * (e.g. user discarded the draft mid-flight) are ignored so the panel
   * doesn't render text from an abandoned run.
   */
  setAiProgress: (sessionId: string, reviewId: string, text: string) => void;

  /**
   * Clear streaming progress for the matching review. Called when an
   * `ai_review_complete` message arrives.
   */
  clearAiProgressForReview: (sessionId: string, reviewId: string) => void;

  /** Read helpers used by selectors / tests. */
  getDraft: (sessionId: string, filePath: string) => FileReview | null;
  getHistory: (sessionId: string, filePath: string) => FileReview[];
}

export const useFileReviewStore = create<FileReviewState>((set, get) => ({
  draftByKey: {},
  historyByKey: {},
  aiLoadingByKey: {},
  aiProgressByKey: {},
  loadingByKey: {},

  load: async (sessionId, filePath) => {
    const key = makeKey(sessionId, filePath);
    set((s) => ({ loadingByKey: { ...s.loadingByKey, [key]: true } }));
    try {
      // Ensure draft exists (creates one if not).
      const draft = await request<FileReview>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/draft`,
        { filePath },
      );
      // Load history (all reviews — drafts + sent).
      const list = await request<{ reviews: FileReview[] }>(
        "GET",
        `/api/sessions/${sessionId}/file-reviews?filePath=${encodeURIComponent(filePath)}`,
      );
      const history = list.reviews.filter((r) => r.status === "sent");
      set((s) => ({
        draftByKey: { ...s.draftByKey, [key]: draft },
        historyByKey: { ...s.historyByKey, [key]: history },
      }));
      return draft;
    } catch (err) {
      console.error("[file-review-store] load failed:", err);
      return null;
    } finally {
      set((s) => ({ loadingByKey: { ...s.loadingByKey, [key]: false } }));
    }
  },

  addLineComment: async (sessionId, filePath, line, text) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return null;
    try {
      const comment = await request<ReviewComment>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
        { kind: "line", line, text },
      );
      set((s) => ({
        draftByKey: {
          ...s.draftByKey,
          [key]: { ...draft, comments: [...draft.comments, comment] },
        },
      }));
      return comment;
    } catch (err) {
      console.error("[file-review-store] addLineComment failed:", err);
      return null;
    }
  },

  addSectionComment: async (sessionId, filePath, sectionHeading, sectionIndex, text) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return null;
    try {
      const comment = await request<ReviewComment>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
        { kind: "section", sectionHeading, sectionIndex, text },
      );
      set((s) => ({
        draftByKey: {
          ...s.draftByKey,
          [key]: { ...draft, comments: [...draft.comments, comment] },
        },
      }));
      return comment;
    } catch (err) {
      console.error("[file-review-store] addSectionComment failed:", err);
      return null;
    }
  },

  editComment: async (sessionId, filePath, commentId, text) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return;
    try {
      await request<{ ok: true }>(
        "PATCH",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments/${commentId}`,
        { text },
      );
      set((s) => ({
        draftByKey: {
          ...s.draftByKey,
          [key]: {
            ...draft,
            comments: draft.comments.map((c) => (c.id === commentId ? { ...c, text } : c)),
          },
        },
      }));
    } catch (err) {
      console.error("[file-review-store] editComment failed:", err);
    }
  },

  deleteComment: async (sessionId, filePath, commentId) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return;
    try {
      await request<{ ok: true }>(
        "DELETE",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments/${commentId}`,
      );
      set((s) => ({
        draftByKey: {
          ...s.draftByKey,
          [key]: {
            ...draft,
            comments: draft.comments.filter((c) => c.id !== commentId),
          },
        },
      }));
    } catch (err) {
      console.error("[file-review-store] deleteComment failed:", err);
    }
  },

  aiReview: async (sessionId, filePath) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return [];
    // Reset progress for this run — any leftover text from a previous
    // run shouldn't bleed into the new "thinking…" panel.
    set((s) => ({
      aiLoadingByKey: { ...s.aiLoadingByKey, [key]: true },
      aiProgressByKey: { ...s.aiProgressByKey, [key]: "" },
    }));
    try {
      const { comments } = await request<{ comments: ReviewComment[] }>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/ai-review`,
      );
      set((s) => {
        const current = s.draftByKey[key];
        if (!current) return s;
        return {
          draftByKey: {
            ...s.draftByKey,
            [key]: { ...current, comments: [...current.comments, ...comments] },
          },
        };
      });
      return comments;
    } catch (err) {
      console.error("[file-review-store] aiReview failed:", err);
      return [];
    } finally {
      set((s) => ({
        aiLoadingByKey: { ...s.aiLoadingByKey, [key]: false },
        aiProgressByKey: omitKey(s.aiProgressByKey, key),
      }));
    }
  },

  setAiProgress: (sessionId, reviewId, text) => {
    // Walk the drafts to find the (session, file) key whose draft.id matches.
    // The keyspace is small (one draft per file the user has opened), so a
    // linear scan is cheap and avoids a separate reviewId → key index.
    const drafts = get().draftByKey;
    const prefix = `${sessionId}::`;
    for (const [key, draft] of Object.entries(drafts)) {
      if (!key.startsWith(prefix) || draft?.id !== reviewId) continue;
      set((s) => ({ aiProgressByKey: { ...s.aiProgressByKey, [key]: text } }));
      return;
    }
  },

  clearAiProgressForReview: (sessionId, reviewId) => {
    const drafts = get().draftByKey;
    const prefix = `${sessionId}::`;
    for (const [key, draft] of Object.entries(drafts)) {
      if (!key.startsWith(prefix) || draft?.id !== reviewId) continue;
      set((s) => ({ aiProgressByKey: omitKey(s.aiProgressByKey, key) }));
      return;
    }
  },

  sendDraft: async (sessionId, filePath) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft || draft.comments.length === 0) return null;
    try {
      const { prompt, review } = await request<{ prompt: string; review: FileReview }>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/send`,
      );
      set((s) => ({
        draftByKey: { ...s.draftByKey, [key]: null },
        historyByKey: {
          ...s.historyByKey,
          [key]: [review, ...(s.historyByKey[key] ?? [])],
        },
      }));
      return prompt;
    } catch (err) {
      console.error("[file-review-store] sendDraft failed:", err);
      return null;
    }
  },

  discardEmptyDraft: async (sessionId, filePath) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft || draft.comments.length > 0) return;
    try {
      await request<{ ok: true }>(
        "DELETE",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}`,
      );
    } catch { /* swallow — best-effort tidy-up */ }
    set((s) => ({ draftByKey: { ...s.draftByKey, [key]: null } }));
  },

  getDraft: (sessionId, filePath) => {
    return get().draftByKey[makeKey(sessionId, filePath)] ?? null;
  },

  getHistory: (sessionId, filePath) => {
    return get().historyByKey[makeKey(sessionId, filePath)] ?? [];
  },
}));

export function fileReviewKey(sessionId: string, filePath: string): string {
  return makeKey(sessionId, filePath);
}
