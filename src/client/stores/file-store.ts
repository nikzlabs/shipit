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

  setTree: (tree: FileTreeNode[]) => void;
  setViewingFile: (path: string | null) => void;
  closeViewer: () => void;
  setDocFiles: (files: string[]) => void;
  selectDoc: (file: string | null) => void;
  setDocContent: (content: string | null) => void;
  setViewingFileContent: (content: string | null) => void;
  setViewingFileBinary: (binary: boolean) => void;
  reset: () => void;

  fetchTree: (sessionId: string) => Promise<void>;
  fetchFile: (sessionId: string, filePath: string) => Promise<void>;
  fetchFileWithTree: (sessionId: string, filePath: string) => Promise<void>;
  refreshFileContent: (sessionId: string, filePath: string) => Promise<void>;
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

  setViewingFileContent: (content) => set({ viewingFileContent: content }),

  setViewingFileBinary: (binary) => set({ viewingFileBinary: binary }),

  reset: () => set(initialState),

  fetchTree: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/files`);
    if (!res.ok) {
      throw new Error(`Failed to fetch file tree: ${res.status}`);
    }
    const { tree } = await res.json() as { tree: FileTreeNode[] };
    set({ tree });
  },

  fetchFile: async (sessionId, filePath) => {
    set({ viewingFile: filePath, viewingFileContent: null, viewingFileBinary: false });
    const res = await fetch(`/api/sessions/${sessionId}/files/${filePath}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch file: ${res.status}`);
    }
    const data = await res.json() as { content: string | null; isBinary: boolean };
    set({ viewingFileContent: data.content, viewingFileBinary: data.isBinary });
  },

  fetchFileWithTree: async (sessionId, filePath) => {
    const res = await fetch(`/api/sessions/${sessionId}/files/${filePath}?tree=true`);
    if (!res.ok) {
      throw new Error(`Failed to fetch file with tree: ${res.status}`);
    }
    const data = await res.json() as { tree: FileTreeNode[]; content: string | null; isBinary?: boolean };
    set({ tree: data.tree, viewingFileContent: data.content, viewingFileBinary: data.isBinary ?? false });
  },

  refreshFileContent: async (sessionId, filePath) => {
    const res = await fetch(`/api/sessions/${sessionId}/files/${filePath}`);
    if (!res.ok) {
      throw new Error(`Failed to refresh file content: ${res.status}`);
    }
    const data = await res.json() as { content: string | null; isBinary?: boolean };
    set({ viewingFileContent: data.content, viewingFileBinary: data.isBinary ?? false });
  },

  fetchDocs: async (sessionId) => {
    const res = await fetch(`/api/sessions/${sessionId}/docs`);
    if (!res.ok) {
      throw new Error(`Failed to fetch docs: ${res.status}`);
    }
    const { files } = await res.json() as { files: string[] };
    set({ docFiles: files });
  },

  fetchDoc: async (sessionId, filePath) => {
    set({ selectedDoc: filePath, docContent: null });
    const res = await fetch(`/api/sessions/${sessionId}/docs/${filePath}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch doc: ${res.status}`);
    }
    const { content } = await res.json() as { content: string | null };
    set({ docContent: content });
  },
}));
