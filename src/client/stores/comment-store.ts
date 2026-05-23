import { create } from "zustand";
import type { LineComment } from "../../server/shared/types.js";

/**
 * Legacy file-comment store used by DiffPanel for per-staged-change line
 * comments. Markdown comments live in `file-review-store.ts` and are
 * server-persisted; this store is local-to-the-browser and only handles line
 * comments on staged diffs.
 */

const STORAGE_KEY = "shipit-file-comments";

function loadFromStorage(): Record<string, LineComment[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, LineComment[]>;
  } catch { /* ignore */ }
  return {};
}

function saveToStorage(data: Record<string, LineComment[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

interface FileCommentState {
  commentsBySession: Record<string, LineComment[]>;

  addLineComment: (sessionId: string, filePath: string, line: number, text: string) => void;
  editComment: (sessionId: string, commentId: string, text: string) => void;
  deleteComment: (sessionId: string, commentId: string) => void;
  clearComments: (sessionId: string) => void;
  getCommentsForFile: (sessionId: string, filePath: string) => LineComment[];
  getAllComments: (sessionId: string) => LineComment[];
  getCommentCount: (sessionId: string) => number;
}

export const useCommentStore = create<FileCommentState>((set, get) => ({
  commentsBySession: loadFromStorage(),

  addLineComment: (sessionId, filePath, line, text) => {
    const comment: LineComment = {
      id: crypto.randomUUID(),
      kind: "line",
      filePath,
      line,
      text,
    };
    set((state) => {
      const session = [...(state.commentsBySession[sessionId] ?? []), comment];
      const next = { ...state.commentsBySession, [sessionId]: session };
      saveToStorage(next);
      return { commentsBySession: next };
    });
  },

  editComment: (sessionId, commentId, text) => {
    set((state) => {
      const session = (state.commentsBySession[sessionId] ?? []).map((c) =>
        c.id === commentId ? { ...c, text } : c,
      );
      const next = { ...state.commentsBySession, [sessionId]: session };
      saveToStorage(next);
      return { commentsBySession: next };
    });
  },

  deleteComment: (sessionId, commentId) => {
    set((state) => {
      const session = (state.commentsBySession[sessionId] ?? []).filter((c) => c.id !== commentId);
      const next = { ...state.commentsBySession, [sessionId]: session };
      saveToStorage(next);
      return { commentsBySession: next };
    });
  },

  clearComments: (sessionId) => {
    set((state) => {
      const { [sessionId]: _, ...rest } = state.commentsBySession;
      saveToStorage(rest);
      return { commentsBySession: rest };
    });
  },

  getCommentsForFile: (sessionId, filePath) => {
    return (get().commentsBySession[sessionId] ?? []).filter((c) => c.filePath === filePath);
  },

  getAllComments: (sessionId) => {
    return get().commentsBySession[sessionId] ?? [];
  },

  getCommentCount: (sessionId) => {
    return (get().commentsBySession[sessionId] ?? []).length;
  },
}));
