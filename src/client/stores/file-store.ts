import { create } from "zustand";
import type { FileTreeNode } from "../components/FileTree.js";
import type { DocEntry, SkillInfo, UploadedFile, UploadItem } from "../../server/shared/types.js";
import { detectFilePreviewType, type FilePreviewType } from "../utils/file-preview-type.js";
import type { FilePreviewAction } from "../components/FilePreviewModal.js";
import { getLocalStorageObject, getSavedDraftUploads, saveDraftUploads } from "../utils/local-storage.js";
import { useSessionStore } from "./session-store.js";

// localStorage-backed set of upload paths the user has explicitly deleted.
// Prevents hydrateUploads from resurrecting them if the server DELETE fails.
const DELETED_UPLOADS_KEY = "shipit:deletedUploads";
function getDeletedUploads(): Set<string> {
  return getLocalStorageObject<Set<string>>(DELETED_UPLOADS_KEY, new Set(), (parsed) => new Set(parsed as string[]));
}
export function markUploadDeleted(path: string) {
  const set = getDeletedUploads();
  set.add(path);
  localStorage.setItem(DELETED_UPLOADS_KEY, JSON.stringify([...set]));
}
// Remove a path from the deleted-uploads tombstone set. A fresh upload (or an
// undone delete) must supersede any stale tombstone for its path — otherwise
// `hydrateUploads` filters the just-uploaded file out on the next reconnect.
// Tombstones are global (not session-scoped), so a same-named file in another
// session can also collide; clearing on upload success resolves both cases.
export function clearUploadTombstone(path: string) {
  const set = getDeletedUploads();
  if (!set.delete(path)) return;
  if (set.size > 0) localStorage.setItem(DELETED_UPLOADS_KEY, JSON.stringify([...set]));
  else clearDeletedUploads();
}
function clearDeletedUploads() {
  localStorage.removeItem(DELETED_UPLOADS_KEY);
}

interface FileState {
  tree: FileTreeNode[];
  viewingFile: string | null;
  viewingFileContent: string | null;
  viewingFileBinary: boolean;
  docFiles: DocEntry[];
  selectedDoc: string | null;
  docContent: string | null;

  // User-invocable skills for the composer's `/` autocomplete (doc 138).
  skills: SkillInfo[];

  // Session uploads — persisted in Zustand to survive route transitions
  sessionUploads: UploadItem[];

  // Unified file preview modal state
  previewFile: string | null;
  previewContent: string | null;
  previewType: FilePreviewType | null;
  previewLoading: boolean;
  previewActions: FilePreviewAction[];
  /**
   * 1-based line to reveal/highlight when opening a code file (e.g. from a
   * `path:line` link in chat). `null` opens at the top. Markdown is rendered,
   * not source, so this only affects the code (Monaco) view.
   */
  previewLine: number | null;

  // Secondary manual file editing dialog state (docs/174).
  editFile: string | null;
  editContent: string;
  editOriginalContent: string;
  editType: FilePreviewType | null;
  editLoading: boolean;
  editSaving: boolean;
  editError: string | null;

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
  openPreview: (sessionId: string, filePath: string, opts?: { actions?: FilePreviewAction[]; line?: number }) => Promise<void>;
  openPreviewWithContent: (filePath: string, content: string, type: FilePreviewType, actions?: FilePreviewAction[]) => void;
  closePreview: () => void;

  openEditor: (sessionId: string, filePath: string) => Promise<void>;
  closeEditor: () => void;
  setEditContent: (content: string) => void;
  saveEditor: (sessionId: string) => Promise<void>;

  fetchTree: (sessionId: string) => Promise<void>;
  fetchFile: (sessionId: string, filePath: string) => Promise<void>;
  fetchFileWithTree: (sessionId: string, filePath: string) => Promise<void>;
  refreshFileContent: (sessionId: string, filePath: string) => Promise<void>;
  fetchDocs: (sessionId: string) => Promise<void>;
  fetchDoc: (sessionId: string, filePath: string) => Promise<void>;
  fetchSkills: (sessionId: string, agentId?: string) => Promise<void>;
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
  skills: [] as SkillInfo[],
  sessionUploads: [] as UploadItem[],
  previewFile: null as string | null,
  previewContent: null as string | null,
  previewType: null as FilePreviewType | null,
  previewLoading: false,
  previewActions: [] as FilePreviewAction[],
  previewLine: null as number | null,
  editFile: null as string | null,
  editContent: "",
  editOriginalContent: "",
  editType: null as FilePreviewType | null,
  editLoading: false,
  editSaving: false,
  editError: null as string | null,
};

function errorMessageFromResponse(status: number, fallback: string, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `${fallback}: ${status}`;
}

export const useFileStore = create<FileState>((set, get) => ({
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
    set((state) => ({
      sessionUploads: state.sessionUploads.map((u) => {
        if (!u.pending) return u;
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
        return { ...u, pending: false, previewUrl: undefined };
      }),
    })),

  hydrateUploads: async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/uploads`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: UploadedFile[] };
      const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg)$/i;
      const deletedPaths = getDeletedUploads();
      // Clean up the deleted set — remove entries for files that no longer exist on the server
      const serverPaths = new Set(data.files.map((f) => f.path));
      let deletedChanged = false;
      for (const dp of deletedPaths) {
        if (!serverPaths.has(dp)) { deletedPaths.delete(dp); deletedChanged = true; }
      }
      if (deletedChanged) {
        if (deletedPaths.size > 0) localStorage.setItem(DELETED_UPLOADS_KEY, JSON.stringify([...deletedPaths]));
        else clearDeletedUploads();
      }

      // A file on disk is, by default, NOT a chip — it was sent in a prior turn
      // or is left over from an earlier visit, so it belongs in the /uploads
      // panel (the agent can still read it) but not the input. The ONE thing
      // that makes a hydrated file a chip again is the per-session draft set:
      // paths the user attached but hasn't sent yet, persisted so the chip
      // survives a reload/session-switch exactly like the composer's draft text.
      //
      // Self-heal the draft set before applying it: drop any path the server no
      // longer has, and any path chat history shows was already sent. This is
      // what structurally prevents the old resurrection bug — even if the
      // send-time removal was missed, an already-sent file is pruned here and
      // never shown as a chip.
      const sentPaths = new Set<string>();
      for (const msg of useSessionStore.getState().messages) {
        if (msg.role !== "user") continue;
        for (const f of msg.files ?? []) {
          if (f.path.startsWith("/uploads/")) sentPaths.add(f.path);
        }
        for (const p of msg.uploadPaths ?? []) sentPaths.add(p);
      }
      const draftSet = new Set(getSavedDraftUploads(sessionId));
      let draftChanged = false;
      for (const p of [...draftSet]) {
        if (!serverPaths.has(p) || sentPaths.has(p)) { draftSet.delete(p); draftChanged = true; }
      }
      if (draftChanged) saveDraftUploads(sessionId, [...draftSet]);

      set((state) => {
        // Preserve in-memory pending items first: a WS reconnect keeps the
        // Zustand store, so a just-attached chip (possibly still uploading, no
        // path yet) must not be wiped. Everything else is rebuilt from disk,
        // pending iff it's in the (self-healed) draft set.
        const pendingInMemory = state.sessionUploads.filter((u) => u.pending);
        const pendingPaths = new Set(
          pendingInMemory.map((u) => u.path).filter((p): p is string => Boolean(p)),
        );
        const hydrated = data.files
          .filter((f) => !deletedPaths.has(f.path) && !pendingPaths.has(f.path))
          .map((f) => {
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
              pending: draftSet.has(f.path),
              previewUrl: isImage ? `/api/sessions/${sessionId}/files/${urlPath}?raw=true` : undefined,
            };
          });
        return { sessionUploads: [...pendingInMemory, ...hydrated] };
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
      previewLine: opts?.line ?? null,
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
      previewLine: null,
    });
  },

  closePreview: () => {
    set({
      previewFile: null,
      previewContent: null,
      previewType: null,
      previewLoading: false,
      previewActions: [],
      previewLine: null,
    });
  },

  openEditor: async (sessionId, filePath) => {
    const detectedType = detectFilePreviewType(filePath);
    set({
      previewFile: null,
      previewContent: null,
      previewType: null,
      previewLoading: false,
      previewActions: [],
      previewLine: null,
      editFile: filePath,
      editContent: "",
      editOriginalContent: "",
      editType: detectedType,
      editLoading: true,
      editSaving: false,
      editError: null,
    });

    const urlPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/${urlPath}`);
      const data = await res.json().catch(() => null) as { content?: string | null; isBinary?: boolean; isImage?: boolean; error?: string } | null;
      if (!res.ok) {
        throw new Error(errorMessageFromResponse(res.status, "Failed to load file", data));
      }
      if (!data || typeof data.content !== "string" || data.isBinary || data.isImage) {
        throw new Error("This file cannot be edited as text.");
      }
      set({
        editContent: data.content,
        editOriginalContent: data.content,
        editType: detectedType,
        editLoading: false,
        editError: null,
      });
    } catch (err) {
      set({
        editLoading: false,
        editError: err instanceof Error ? err.message : "Failed to load file",
      });
    }
  },

  closeEditor: () => {
    set({
      editFile: null,
      editContent: "",
      editOriginalContent: "",
      editType: null,
      editLoading: false,
      editSaving: false,
      editError: null,
    });
  },

  setEditContent: (content) => set({ editContent: content, editError: null }),

  saveEditor: async (sessionId) => {
    const { editFile, editContent } = get();
    if (!editFile) return;
    set({ editSaving: true, editError: null });
    const urlPath = editFile.startsWith("/") ? editFile.slice(1) : editFile;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/${urlPath}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(errorMessageFromResponse(res.status, "Failed to save file", data));
      }
      set({
        editOriginalContent: editContent,
        editSaving: false,
        editError: null,
      });
      await get().fetchTree(sessionId).catch(() => {});
    } catch (err) {
      set({
        editSaving: false,
        editError: err instanceof Error ? err.message : "Failed to save file",
      });
      throw err;
    }
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

  fetchSkills: async (sessionId, agentId) => {
    const query = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
    const res = await fetch(`/api/sessions/${sessionId}/skills${query}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch skills: ${res.status}`);
    }
    const { skills } = await res.json() as { skills: SkillInfo[] };
    set({ skills });
  },
}));
