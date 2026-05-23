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

  /** Add a selection-anchored comment. Only valid for markdown reviews. */
  addSelectionComment: (
    sessionId: string,
    filePath: string,
    quotedText: string,
    contextBefore: string,
    contextAfter: string,
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

  /**
   * Apply a `review_updated` WS message (docs/125): the chat-native review
   * subagent wrote anchored comments via `submit_review_comments`, and the
   * server broadcast the authoritative updated draft. Replace the local draft
   * so an open modal renders the new AI comments live.
   */
  applyReviewUpdate: (review: FileReview) => void;

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

  /** Read helpers used by selectors / tests. */
  getDraft: (sessionId: string, filePath: string) => FileReview | null;
  getHistory: (sessionId: string, filePath: string) => FileReview[];
}

export const useFileReviewStore = create<FileReviewState>((set, get) => ({
  draftByKey: {},
  historyByKey: {},
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

  addSelectionComment: async (sessionId, filePath, quotedText, contextBefore, contextAfter, text) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft) return null;
    try {
      const comment = await request<ReviewComment>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/comments`,
        { kind: "selection", quotedText, contextBefore, contextAfter, text },
      );
      set((s) => ({
        draftByKey: {
          ...s.draftByKey,
          [key]: { ...draft, comments: [...draft.comments, comment] },
        },
      }));
      return comment;
    } catch (err) {
      console.error("[file-review-store] addSelectionComment failed:", err);
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

  applyReviewUpdate: (review) => {
    const key = makeKey(review.sessionId, review.filePath);
    set((s) => ({ draftByKey: { ...s.draftByKey, [key]: review } }));
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
