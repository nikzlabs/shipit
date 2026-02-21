import { create } from "zustand";
import type { FileTreeNode } from "../components/FileTree.js";

interface FileState {
  tree: FileTreeNode[];
  viewingFile: string | null;
  viewingFileContent: string | null;
  viewingFileBinary: boolean;
  docFiles: string[];
  selectedDoc: string | null;
  docContent: string | null;
  changeCount: number;

  setTree: (tree: FileTreeNode[]) => void;
  setViewingFile: (path: string | null) => void;
  closeViewer: () => void;
  setDocFiles: (files: string[]) => void;
  selectDoc: (file: string | null) => void;
  setDocContent: (content: string | null) => void;
  incrementChangeCount: (count?: number) => void;
  resetChangeCount: () => void;
  setViewingFileContent: (content: string | null) => void;
  setViewingFileBinary: (binary: boolean) => void;
  reset: () => void;

  fetchTree: (sessionId: string) => Promise<void>;
  fetchFile: (sessionId: string, filePath: string) => Promise<void>;
  fetchDocs: (sessionId: string) => Promise<void>;
  fetchDoc: (sessionId: string, filePath: string) => Promise<void>;
}

const initialState = {
  tree: [] as FileTreeNode[],
  viewingFile: null as string | null,
  viewingFileContent: null as string | null,
  viewingFileBinary: false,
  docFiles: [] as string[],
  selectedDoc: null as string | null,
  docContent: null as string | null,
  changeCount: 0,
};

export const useFileStore = create<FileState>((set) => ({
  ...initialState,

  setTree: (tree) => set({ tree }),

  setViewingFile: (path) => set({ viewingFile: path }),

  closeViewer: () =>
    set({ viewingFile: null, viewingFileContent: null, viewingFileBinary: false }),

  setDocFiles: (files) => set({ docFiles: files }),

  selectDoc: (file) => set({ selectedDoc: file }),

  setDocContent: (content) => set({ docContent: content }),

  incrementChangeCount: (count = 1) =>
    set((state) => ({ changeCount: state.changeCount + count })),

  resetChangeCount: () => set({ changeCount: 0 }),

  setViewingFileContent: (content) => set({ viewingFileContent: content }),

  setViewingFileBinary: (binary) => set({ viewingFileBinary: binary }),

  reset: () => set(initialState),

  fetchTree: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/files`);
    if (!res.ok) {
      throw new Error(`Failed to fetch file tree: ${res.status}`);
    }
    const { tree } = await res.json();
    set({ tree });
  },

  fetchFile: async (sessionId, filePath) => {
    set({ viewingFile: filePath, viewingFileContent: null, viewingFileBinary: false });
    const res = await fetch(`/api/sessions/${sessionId}/files/${filePath}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch file: ${res.status}`);
    }
    const data = await res.json();
    set({ viewingFileContent: data.content, viewingFileBinary: data.isBinary });
  },

  fetchDocs: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/docs`);
    if (!res.ok) {
      throw new Error(`Failed to fetch docs: ${res.status}`);
    }
    const { files } = await res.json();
    set({ docFiles: files });
  },

  fetchDoc: async (sessionId, filePath) => {
    set({ selectedDoc: filePath, docContent: null });
    const res = await fetch(`/api/sessions/${sessionId}/docs/${filePath}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch doc: ${res.status}`);
    }
    const { content } = await res.json();
    set({ docContent: content });
  },
}));
