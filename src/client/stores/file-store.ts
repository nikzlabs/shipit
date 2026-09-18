import { create } from "zustand";
import type { FileTreeNode } from "../components/FileTree.js";
import type { DocEntry, SkillInfo, UploadedFile, UploadItem } from "../../server/shared/types.js";
import { detectFilePreviewType, type FilePreviewType } from "../utils/file-preview-type.js";
import type { FilePreviewAction } from "../components/FilePreviewModal.js";
import { getLocalStorageObject, getSavedDraftUploads, saveDraftUploads } from "../utils/local-storage.js";
import { useSessionStore } from "./session-store.js";

const DELETED_UPLOADS_KEY = "shipit:deletedUploads";
function getDeletedUploads(): Set<string> {
  return getLocalStorageObject<Set<string>>(DELETED_UPLOADS_KEY, new Set(), (parsed) => new Set(parsed as string[]));
}
export function markUploadDeleted(path: string) {
  const set = getDeletedUploads();
  set.add(path);
  localStorage.setItem(DELETED_UPLOADS_KEY, JSON.stringify([...set]));
}

// undone delete) must supersede any stale tombstone for its path — otherwise

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

  skills: SkillInfo[];

  sessionUploads: UploadItem[];

  previewFile: string | null;
  previewContent: string | null;
  previewType: FilePreviewType | null;
  previewLoading: boolean;
  previewActions: FilePreviewAction[];

  previewLine: number | null;

  previewOnDisk: boolean;

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

  addSessionUploads: (items: UploadItem[]) => void;
  removeSessionUpload: (path: string) => void;
  removeSessionUploadById: (id: string) => void;
  updateSessionUpload: (id: string, patch: Partial<UploadItem>) => void;
  markUploadsSent: () => void;
  hydrateUploads: (sessionId: string, attempt?: number) => Promise<void>;

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
  previewOnDisk: false,
  editFile: null as string | null,
  editContent: "",
  editOriginalContent: "",
  editType: null as FilePreviewType | null,
  editLoading: false,
  editSaving: false,
  editError: null as string | null,
};

/**
 * docs/293 req 3 — the bytes behind each upload chip that has not landed on the
 * server yet, so "Retry" can re-POST them and a remounted composer can resume an
 * upload it did not start.
 *
 * This lives beside the store, NOT inside `useFileUpload`, because the two have
 * different lifetimes and that difference was a defect: the chips are store
 * state, while a hook is remounted whenever the layout crosses the mobile
 * breakpoint (`AppLayout` swaps component trees) — leaving a chip on screen whose
 * bytes had gone, so Retry deleted the attachment and a deferred upload sat at
 * "uploading" forever. Keyed by upload-item id, cleared by exactly the store
 * actions that drop the chips, so it can neither go stale nor outlive what is on
 * screen.
 */
const uploadBytes = new Map<string, File>();

export function retainUploadBytes(id: string, file: File): void {
  uploadBytes.set(id, file);
}

export function getUploadBytes(id: string): File | undefined {
  return uploadBytes.get(id);
}

export function pendingUploadBytes(): { id: string; file: File }[] {
  return [...uploadBytes].map(([id, file]) => ({ id, file }));
}

export function releaseUploadBytes(id: string): void {
  uploadBytes.delete(id);
}

const activeUploads = new Set<string>();

export function markUploadActive(id: string): void {
  activeUploads.add(id);
}

export function markUploadSettled(id: string): void {
  activeUploads.delete(id);
}

export function isUploadActive(id: string): boolean {
  return activeUploads.has(id);
}

export function hasActiveUploads(): boolean {
  return activeUploads.size > 0;
}

/**
 * Uploads the user explicitly dismissed while they were still in flight.
 *
 * docs/294 req 7 — the completion handler has to know WHY a chip is missing, and
 * the chip list cannot tell it: `switchSession` clears every chip, so "gone"
 * means both "the user removed it" and "the user went elsewhere". Inferring it
 * from the current session id fails in both directions — A→B→A restores the
 * session without restoring the chip (so a live upload was deleted), and
 * Remove-then-switch loses the removal (so a dismissed attachment came back).
 * Recording the intent against the upload's own id is the only thing that
 * survives both journeys. NOT cleared on session switch, for exactly that
 * reason.
 */
const dismissedUploads = new Set<string>();

export function noteUploadDismissed(id: string): void {
  dismissedUploads.add(id);
}

export function wasUploadDismissed(id: string): boolean {
  return dismissedUploads.has(id);
}

export function forgetUploadDismissal(id: string): void {
  dismissedUploads.delete(id);
}

/**
 * docs/294 — the two counters that tell `hydrateUploads` whether its answer is
 * still true by the time it arrives.
 *
 * `uploadsChangeSeq` moves whenever the set of files on the server changes from
 * this client (an upload lands, a file is deleted). A listing requested before
 * such a change describes a world that no longer exists, and applying it left
 * the panel showing a set of files that is not the one on disk.
 *
 * It is keyed BY SESSION, and that is load-bearing rather than tidy: a session's
 * uploads go on completing after the user has switched away, and a global
 * counter let those completions invalidate the *new* session's perfectly
 * current listing — four of them in a row would exhaust the retry chain and
 * leave the new session's panel empty.
 *
 * `hydrateSeq` identifies the newest hydration. An older one must not apply its
 * answer over a newer one's, and must not refetch either: the newer request is
 * already doing that.
 */
const uploadsChangeSeq = new Map<string, number>();
let hydrateSeq = 0;

const MAX_HYDRATE_REFETCHES = 3;

export function noteUploadsChanged(sessionId: string): void {
  uploadsChangeSeq.set(sessionId, (uploadsChangeSeq.get(sessionId) ?? 0) + 1);
}

/**
 * Forget every pending upload: its bytes, and the record that a request is
 * running for it. Called when the chips themselves are dropped (a session
 * switch), where an in-flight request has nothing left to update and an id with
 * no chip can never be resumed — so keeping either would only leak.
 */
export function forgetPendingUploads(): void {
  uploadBytes.clear();
  activeUploads.clear();
}

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

  reset: () => {
    forgetPendingUploads();
    set(initialState);
  },

  addSessionUploads: (items) =>
    set((state) => ({ sessionUploads: [...state.sessionUploads, ...items] })),

  removeSessionUpload: (path) =>
    set((state) => {
      for (const u of state.sessionUploads) {
        if (u.path === path) releaseUploadBytes(u.id);
      }
      return { sessionUploads: state.sessionUploads.filter((u) => u.path !== path) };
    }),

  removeSessionUploadById: (id) => {
    releaseUploadBytes(id);
    set((state) => ({ sessionUploads: state.sessionUploads.filter((u) => u.id !== id) }));
  },

  updateSessionUpload: (id, patch) =>
    set((state) => ({
      sessionUploads: state.sessionUploads.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    })),

  markUploadsSent: () => {

    set((state) => ({
      sessionUploads: state.sessionUploads.map((u) => {
        if (!u.pending) return u;
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
        return { ...u, pending: false, previewUrl: undefined };
      }),
    }));
  },

  hydrateUploads: async (sessionId, attempt = 0) => {

    // is no longer current must not get that authority.
    const seq = ++hydrateSeq;
    const changeAtStart = uploadsChangeSeq.get(sessionId) ?? 0;
    // docs/294 req 1 — a mutation that is still UNRESOLVED cannot have bumped
    // the counter yet, so the counter alone cannot see this overlap. A listing

    const mutatingAtStart = hasActiveUploads();
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files/uploads`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: UploadedFile[] };

      // req 3 — a newer hydration owns the store now. Drop this one, and do NOT

      if (seq !== hydrateSeq) return;

      if (useSessionStore.getState().sessionId !== sessionId) return;
      // req 1 — the listing predates a change this client made, so it cannot

      // policy beyond this) so a session churning uploads cannot spin the

      if (
        (uploadsChangeSeq.get(sessionId) ?? 0) !== changeAtStart
        || mutatingAtStart
        || hasActiveUploads()
      ) {
        if (attempt < MAX_HYDRATE_REFETCHES) {
          void get().hydrateUploads(sessionId, attempt + 1);
        }
        return;
      }
      const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg)$/i;
      const deletedPaths = getDeletedUploads();

      const serverPaths = new Set(data.files.map((f) => f.path));
      let deletedChanged = false;
      for (const dp of deletedPaths) {
        if (!serverPaths.has(dp)) { deletedPaths.delete(dp); deletedChanged = true; }
      }
      if (deletedChanged) {
        if (deletedPaths.size > 0) localStorage.setItem(DELETED_UPLOADS_KEY, JSON.stringify([...deletedPaths]));
        else clearDeletedUploads();
      }

      // already-sent file is pruned here and never shown as a chip.

      // docs/294 req 4 — it deliberately does NOT prune a path merely because

      // deleted out of shared localStorage, and the counters below cannot see

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
        if (sentPaths.has(p)) { draftSet.delete(p); draftChanged = true; }
      }
      if (draftChanged) saveDraftUploads(sessionId, [...draftSet]);

      set((state) => {

        // path yet) must not be wiped. Everything else is rebuilt from disk,

        const pendingInMemory = state.sessionUploads.filter((u) => u.pending);
        const pendingPaths = new Set(
          pendingInMemory.map((u) => u.path).filter((p): p is string => Boolean(p)),
        );
        const hydrated = data.files
          .filter((f) => !deletedPaths.has(f.path) && !pendingPaths.has(f.path))
          .map((f) => {

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
      previewOnDisk: true,
    });

    const urlPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

    if (detectedType === "markdown") {

      try {
        const res = await fetch(`/api/sessions/${sessionId}/docs/${urlPath}`);
        if (!res.ok) throw new Error(`Failed to fetch doc: ${res.status}`);
        const { content } = await res.json() as { content: string };
        set({ previewContent: content, previewLoading: false });
      } catch {
        set({ previewContent: "_Failed to load document._", previewLoading: false });
      }
    } else {

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
      previewOnDisk: false,
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
      previewOnDisk: false,
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
      previewOnDisk: false,
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
