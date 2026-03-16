import { create } from "zustand";
import type { FileComment, LineComment, SectionComment } from "../../server/shared/types.js";

const STORAGE_KEY = "shipit-file-comments";

function loadFromStorage(): Record<string, FileComment[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, FileComment[]>;
  } catch { /* ignore */ }
  return {};
}

function saveToStorage(data: Record<string, FileComment[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

interface FileCommentState {
  commentsBySession: Record<string, FileComment[]>;

  addLineComment: (sessionId: string, filePath: string, line: number, text: string) => void;
  addSectionComment: (sessionId: string, filePath: string, sectionHeading: string, sectionIndex: number, text: string) => void;
  editComment: (sessionId: string, commentId: string, text: string) => void;
  deleteComment: (sessionId: string, commentId: string) => void;
  clearComments: (sessionId: string) => void;
  getCommentsForFile: (sessionId: string, filePath: string) => FileComment[];
  getAllComments: (sessionId: string) => FileComment[];
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

  addSectionComment: (sessionId, filePath, sectionHeading, sectionIndex, text) => {
    const comment: SectionComment = {
      id: crypto.randomUUID(),
      kind: "section",
      filePath,
      sectionHeading,
      sectionIndex,
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
