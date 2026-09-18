

import { create } from "zustand";
import type { FileReview, ReviewComment } from "../../server/shared/types.js";

function makeKey(sessionId: string, filePath: string): string {
  return `${sessionId}::${filePath}`;
}

export interface SentDraftPayload {
  prompt: string;
  filePath: string;
  commentCount: number;
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

  draftByKey: Record<string, FileReview | null>;

  historyByKey: Record<string, FileReview[]>;

  loadingByKey: Record<string, boolean>;
  /**
   * True while an unsaved comment editor is open for the (session, file) —
   * the add-comment input or an in-place edit of an existing comment. Purely
   * client-side transient state (never round-trips to the server); it exists
   * so the footer can disable "Send comments" and the user can't submit the
   * review with a half-typed comment that would be silently dropped.
   *
   * The comment renderers own the flag and clear it on unmount, so closing the
   * viewer mid-compose can't strand it at `true`.
   */
  composingByKey: Record<string, boolean>;

  load: (sessionId: string, filePath: string) => Promise<FileReview | null>;

  setComposing: (sessionId: string, filePath: string, composing: boolean) => void;

  addLineComment: (
    sessionId: string,
    filePath: string,
    line: number,
    text: string,
  ) => Promise<ReviewComment | null>;

  addSelectionComment: (
    sessionId: string,
    filePath: string,
    quotedText: string,
    contextBefore: string,
    contextAfter: string,
    text: string,
  ) => Promise<ReviewComment | null>;

  editComment: (
    sessionId: string,
    filePath: string,
    commentId: string,
    text: string,
  ) => Promise<void>;

  deleteComment: (
    sessionId: string,
    filePath: string,
    commentId: string,
  ) => Promise<void>;

  sendDraft: (
    sessionId: string,
    filePath: string,

    note?: string,
  ) => Promise<SentDraftPayload | null>;

  discardEmptyDraft: (sessionId: string, filePath: string) => Promise<void>;

  getDraft: (sessionId: string, filePath: string) => FileReview | null;
  getHistory: (sessionId: string, filePath: string) => FileReview[];
  isComposing: (sessionId: string, filePath: string) => boolean;
}

export const useFileReviewStore = create<FileReviewState>((set, get) => ({
  draftByKey: {},
  historyByKey: {},
  loadingByKey: {},
  composingByKey: {},

  setComposing: (sessionId, filePath, composing) => {
    const key = makeKey(sessionId, filePath);

    if ((get().composingByKey[key] ?? false) === composing) return;
    set((s) => ({ composingByKey: { ...s.composingByKey, [key]: composing } }));
  },

  load: async (sessionId, filePath) => {
    const key = makeKey(sessionId, filePath);
    set((s) => ({ loadingByKey: { ...s.loadingByKey, [key]: true } }));
    try {

      const draft = await request<FileReview>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/draft`,
        { filePath },
      );

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

  sendDraft: async (sessionId, filePath, note) => {
    const key = makeKey(sessionId, filePath);
    const draft = get().draftByKey[key];
    if (!draft || draft.comments.length === 0) return null;
    try {
      const { prompt, review } = await request<{ prompt: string; review: FileReview }>(
        "POST",
        `/api/sessions/${sessionId}/file-reviews/${draft.id}/send`,
        { note: note?.trim() ?? "" },
      );
      set((s) => ({
        draftByKey: { ...s.draftByKey, [key]: null },
        historyByKey: {
          ...s.historyByKey,
          [key]: [review, ...(s.historyByKey[key] ?? [])],
        },
      }));
      return { prompt, filePath: review.filePath, commentCount: review.comments.length };
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

  isComposing: (sessionId, filePath) => {
    return get().composingByKey[makeKey(sessionId, filePath)] ?? false;
  },
}));
