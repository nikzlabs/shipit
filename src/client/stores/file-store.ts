import { create } from "zustand";
import type { FileTreeNode } from "../components/FileTree.js";
import type { DocEntry, UploadedFile, UploadItem } from "../../server/shared/types.js";
import { detectFilePreviewType, type FilePreviewType } from "../utils/file-preview-type.js";
import type { FilePreviewAction } from "../components/FilePreviewModal.js";
import { useSessionStore } from "./session-store.js";

interface FileState {
  tree: FileTreeNode[];
  viewingFile: string | null;
  viewingFileContent: string | null;
  viewingFileBinary: boolean;
  docFiles: DocEntry[];
  selectedDoc: string | null;
  docContent: string | null;

  // Session uploads — persisted in Zustand to survive route transitions
  sessionUploads: UploadItem[];

  // Unified file preview modal state
  previewFile: string | null;
  previewContent: string | null;
  previewType: FilePreviewType | null;
  previewLoading: boolean;
  previewActions: FilePreviewAction[];

  setTree: (tree: FileTreeNode[]) => void;
  setViewingFile: (path: string | null) => void;
  closeViewer: () => void;
  setDocFiles: (files: DocEntry[]) => void;
  selectDoc: (file: string | null) => void;
  setDocContent: (content: string | null) => void;
  setViewingFileContent: (content: string | null) => void;
  setViewingFileBinary: (binary: boolean) => void;
  reset: () => void;

  // Session upload actions
  addSessionUploads: (items: UploadItem[]) => void;
  removeSessionUpload: (path: string) => void;
  removeSessionUploadById: (id: string) => void;
  updateSessionUpload: (id: string, patch: Partial<UploadItem>) => void;
  markUploadsSent: () => void;
  hydrateUploads: (sessionId: string) => Promise<void>;

  // Unified preview actions
  openPreview: (sessionId: string, filePath: string, opts?: { actions?: FilePreviewAction[] }) => Promise<void>;
  openPreviewWithContent: (filePath: string, content: string, type: FilePreviewType, actions?: FilePreviewAction[]) => void;
  closePreview: () => void;

  fetchTree: (sessionId: string) => Promise<void>;
  fetchFile: (sessionId: string, filePath: string) => Promise<void>;
  fetchFileWithTree: (sessionId: string, filePath: string) => Promise<void>;
  refreshFileContent: (sessionId: string, filePath: string) => Promise<void>;
  fetchDocs: (sessionId: string) => Promise<void>;
  fetchDoc: (sessionId: string, filePath: string) => Promise<void>;
}

let uploadIdCounter = 0;

const initialState = {
  tree: [] as FileTreeNode[],
  viewingFile: null as string | null,
  viewingFileContent: null as string | null,
  viewingFileBinary: false,
  docFiles: [] as DocEntry[],
  selectedDoc: null as string | null,
  docContent: null as string | null,
  sessionUploads: [] as UploadItem[],
  previewFile: null as string | null,
  previewContent: null as string | null,
  previewType: null as FilePreviewType | null,
  previewLoading: false,
  previewActions: [] as FilePreviewAction[],
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

  addSessionUploads: (items) =>
    set((state) => ({ sessionUploads: [...state.sessionUploads, ...items] })),

  removeSessionUpload: (path) =>
    set((state) => ({ sessionUploads: state.sessionUploads.filter((u) => u.path !== path) })),

  removeSessionUploadById: (id) =>
    set((state) => ({ sessionUploads: state.sessionUploads.filter((u) => u.id !== id) })),

  updateSessionUpload: (id, patch) =>
    set((state) => ({
      sessionUploads: state.sessionUploads.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    })),

  markUploadsSent: () =>
    set((state) => {
      for (const u of state.sessionUploads) {
        if (u.pending && u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      }
      return {
        sessionUploads: state.sessionUploads.map((u) =>
          u.pending ? { ...u, pending: false, previewUrl: undefined } : u,
        ),
      };
    }),

  hydrateUploads: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/uploads`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: UploadedFile[] };
      // Determine which uploads were already sent by checking chat history.
      // Uploads whose paths appear in a user message's files array are "sent".
      // Unreferenced uploads remain pending (attached for the next message).
      const messages = useSessionStore.getState().messages;
      const sentPaths = new Set<string>();
      for (const msg of messages) {
        if (msg.role === "user" && msg.files) {
          for (const f of msg.files) {
            if (f.path.startsWith("/uploads/")) sentPaths.add(f.path);
          }
        }
      }
      const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg)$/i;
      set({
        sessionUploads: data.files.map((f) => {
          // For image uploads, construct a URL the browser can use as <img src>
          const isImage = IMAGE_EXTS.test(f.name);
          const urlPath = f.path.startsWith("/") ? f.path.slice(1) : f.path;
          return {
            id: `hydrated-${++uploadIdCounter}`,
            name: f.name,
            status: "ready" as const,
            size: f.size,
            path: f.path,
            progress: 100,
            pending: !sentPaths.has(f.path),
            previewUrl: isImage ? `/api/sessions/${sessionId}/files/${urlPath}?raw=true` : undefined,
          };
        }),
      });
    } catch {
      // Hydration failure is non-critical
    }
  },

  openPreview: async (sessionId, filePath, opts) => {
    const detectedType = detectFilePreviewType(filePath);
    set({
      previewFile: filePath,
      previewContent: null,
      previewType: detectedType,
      previewLoading: true,
      previewActions: opts?.actions ?? [],
    });

    // Normalize path for URL construction (strip leading slash from upload paths)
    const urlPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

    if (detectedType === "markdown") {
      // Fetch via docs endpoint for markdown
      try {
        const res = await fetch(`/api/sessions/${sessionId}/docs/${urlPath}`);
        if (!res.ok) throw new Error(`Failed to fetch doc: ${res.status}`);
        const { content } = await res.json() as { content: string };
        set({ previewContent: content, previewLoading: false });
      } catch {
        set({ previewContent: "_Failed to load document._", previewLoading: false });
      }
    } else {
      // Fetch via files endpoint for code/image/binary
      try {
        const res = await fetch(`/api/sessions/${sessionId}/files/${urlPath}`);
        if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
        const data = await res.json() as { content: string | null; isBinary?: boolean; isImage?: boolean };
        if (data.isImage) {
          set({ previewContent: data.content, previewType: "image", previewLoading: false });
        } else if (data.isBinary) {
          set({ previewContent: data.content, previewType: "binary", previewLoading: false });
        } else {
          set({ previewContent: data.content, previewLoading: false });
        }
      } catch {
        set({ previewContent: null, previewType: "binary", previewLoading: false });
      }
    }
  },

  openPreviewWithContent: (filePath, content, type, actions) => {
    set({
      previewFile: filePath,
      previewContent: content,
      previewType: type,
      previewLoading: false,
      previewActions: actions ?? [],
    });
  },

  closePreview: () => {
    set({
      previewFile: null,
      previewContent: null,
      previewType: null,
      previewLoading: false,
      previewActions: [],
    });
  },

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
    const { docs } = await res.json() as { docs: DocEntry[] };
    set({ docFiles: docs });
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
