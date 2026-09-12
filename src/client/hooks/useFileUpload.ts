

// eslint-disable-next-line no-restricted-imports -- useEffect: resume uploads when sessionId becomes available
import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { UploadedFile, UploadRef, UploadItem } from "../../server/shared/types.js";
import {
  useFileStore,
  markUploadDeleted,
  clearUploadTombstone,
  retainUploadBytes,
  getUploadBytes,
  noteUploadDismissed,
  wasUploadDismissed,
  forgetUploadDismissal,
  pendingUploadBytes,
  releaseUploadBytes,
  markUploadActive,
  markUploadSettled,
  isUploadActive,
  noteUploadsChanged,
} from "../stores/file-store.js";
import { addDraftUpload, removeDraftUploads } from "../utils/local-storage.js";

export type { UploadItem, UploadStatus } from "../../server/shared/types.js";

interface UploadResponse {
  files: UploadedFile[];
}

let uploadIdCounter = 0;

/**
 * Best-effort DELETE of an uploaded file nothing on screen refers to any more.
 * Exported because the Uploads panel deletes files too, and docs/294 req 1 wants
 * every writer to invalidate an in-flight listing — a hand-rolled fetch at
 * another call site is exactly the writer that gets forgotten.
 */
export async function deleteUploadFromServer(sessionId: string, uploadPath: string): Promise<void> {
  const filename = uploadPath.replace(/^\/uploads\//, "");
  try {
    const res = await fetch(
      `/api/sessions/${sessionId}/files/uploads/${encodeURIComponent(filename)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      console.warn(`[upload] DELETE ${uploadPath} failed: ${res.status} ${res.statusText}`);
      // A definite refusal changed nothing, so it must NOT spend a listing's

      return;
    }

    noteUploadsChanged(sessionId);
  } catch (err: unknown) {

    console.warn("[upload] DELETE failed:", err);
    noteUploadsChanged(sessionId);
  }
}

export function useFileUpload(sessionId: string | undefined) {
  const pendingUploads = useFileStore(useShallow((s) => s.sessionUploads.filter((u) => u.pending)));

  const uploadToServer = useCallback(async (sid: string, files: File[], items: UploadItem[]) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append("file", file);
    }
    for (const item of items) markUploadActive(item.id);
    try {
      const res = await fetch(`/api/sessions/${sid}/files/uploads`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        const errorMsg = body.error ?? res.statusText;
        const st = useFileStore.getState();
        for (const item of items) {
          st.updateSessionUpload(item.id, { status: "error", error: errorMsg, progress: 0 });
        }
        return;
      }
      const data = (await res.json()) as UploadResponse;
      const st = useFileStore.getState();
      for (let i = 0; i < items.length; i++) {
        const uploaded = data.files[i];
        if (uploaded) {

          // cleared every chip when they went elsewhere. The chip list cannot

          if (wasUploadDismissed(items[i].id)) {
            releaseUploadBytes(items[i].id);
            forgetUploadDismissal(items[i].id);
            markUploadDeleted(uploaded.path);
            void deleteUploadFromServer(sid, uploaded.path);
            continue;
          }
          if (!st.sessionUploads.some((u) => u.id === items[i].id)) {

            releaseUploadBytes(items[i].id);
            clearUploadTombstone(uploaded.path);
            addDraftUpload(sid, uploaded.path);
            continue;
          }

          clearUploadTombstone(uploaded.path);

          // left here after the file is sent never resurrects a chip.
          addDraftUpload(sid, uploaded.path);
          st.updateSessionUpload(items[i].id, {
            status: "ready",
            name: uploaded.name,
            path: uploaded.path,
            size: uploaded.size,
            progress: 100,
          });

          releaseUploadBytes(items[i].id);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Upload failed";
      const st = useFileStore.getState();
      for (const item of items) {
        st.updateSessionUpload(item.id, { status: "error", error: errorMsg, progress: 0 });
      }
    } finally {
      for (const item of items) markUploadSettled(item.id);

      noteUploadsChanged(sid);
    }
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const store = useFileStore.getState();

      const items: UploadItem[] = files.map((f) => ({
        id: `upload-${++uploadIdCounter}`,
        name: f.name,
        status: "uploading" as const,
        size: f.size,
        progress: 0,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
        mimeType: f.type.startsWith("image/") ? f.type : undefined,
        pending: true,
      }));

      store.addSessionUploads(items);
      for (let i = 0; i < files.length; i++) {
        retainUploadBytes(items[i].id, files[i]);
      }

      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith("image/")) {
          const reader = new FileReader();
          const itemId = items[i].id;
          reader.onload = () => {
            useFileStore.getState().updateSessionUpload(itemId, { dataUrl: reader.result as string });
          };
          reader.readAsDataURL(files[i]);
        }
      }

      if (!sessionId) return;

      await uploadToServer(sessionId, files, items);
    },
    [sessionId, uploadToServer],
  );

  /**
   * Start (or restart) the POST for every chip that still reads "uploading" and
   * still has its bytes. This is one pass rather than two because the two cases
   * it covers are the same state seen from different angles:
   *
   *   - a session did not exist when the file was attached (the /{slug}/new view
   *     before claimSession resolves), and now it does;
   *   - THIS hook was remounted before the POST was ever started, so the queue
   *     that would have started it belonged to a hook that no longer exists.
   *     Crossing the mobile breakpoint does that (`AppLayout` swaps component
   *     trees), and the chip was left at "uploading" forever with docs/293 req 1
   *     barring Send.
   *
   * Deriving the work from store state instead of a hook-local queue is what
   * makes the second case heal itself: a remounted hook re-derives it.
   *
   * `isUploadActive` is what keeps that from becoming a duplicate-upload bug.
   * Unmounting does NOT cancel an in-flight `fetch` — it runs to completion and
   * still writes to the store — so a chip mid-upload has an owner even though its
   * hook is gone, and must not be restarted. The same check absorbs React
   * StrictMode's double-invoked mount effect.
   */
  // eslint-disable-next-line no-restricted-syntax -- resumes uploads owned by a hook instance that no longer exists
  useEffect(() => {
    if (!sessionId) return;
    const all = useFileStore.getState().sessionUploads;
    const items: UploadItem[] = [];
    const files: File[] = [];
    for (const { id, file } of pendingUploadBytes()) {
      if (isUploadActive(id)) continue;
      const item = all.find((u) => u.id === id);
      if (item?.status !== "uploading") continue;
      items.push(item);
      files.push(file);
    }
    if (files.length > 0) {
      void uploadToServer(sessionId, files, items);
    }
  }, [sessionId, uploadToServer]);

  const removeUpload = useCallback((index: number) => {
    const item = pendingUploads[index];
    if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);

    noteUploadDismissed(item.id);
    if (item.path && sessionId) {
      markUploadDeleted(item.path);

      removeDraftUploads(sessionId, [item.path]);
      void deleteUploadFromServer(sessionId, item.path);
      useFileStore.getState().removeSessionUpload(item.path);
    } else {
      useFileStore.getState().removeSessionUploadById(item.id);
    }
  }, [sessionId, pendingUploads]);

  const retryUpload = useCallback((index: number) => {
    const item = pendingUploads[index];
    if (item?.status !== "error") return;
    const file = getUploadBytes(item.id);
    if (!file) return;
    if (isUploadActive(item.id)) return;
    const retried: UploadItem = { ...item, status: "uploading", progress: 0 };
    useFileStore.getState().updateSessionUpload(item.id, {
      status: "uploading",
      progress: 0,
      error: undefined,
    });

    if (!sessionId) return;
    void uploadToServer(sessionId, [file], [retried]);
  }, [pendingUploads, sessionId, uploadToServer]);

  const getUploadRefs = useCallback((): UploadRef[] => {
    return pendingUploads
      .filter((u) => u.status === "ready" && u.path)
      .map((u) => ({ path: u.path!, type: "upload" as const }));
  }, [pendingUploads]);

  const clearUploads = useCallback(() => {
    const sentPaths = pendingUploads.map((u) => u.path).filter((p): p is string => Boolean(p));

    useFileStore.getState().markUploadsSent();

    if (sessionId) removeDraftUploads(sessionId, sentPaths);
  }, [pendingUploads, sessionId]);

  return {

    uploads: pendingUploads,
    uploadFiles,
    removeUpload,
    retryUpload,
    getUploadRefs,
    clearUploads,
  };
}
