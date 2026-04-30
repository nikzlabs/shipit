/**
 * useFileUpload — manages file upload API calls.
 * All upload state lives in the file store (Zustand) so it survives page reloads.
 * Pending uploads (not yet sent in a message) are shown as input chips.
 *
 * Files attached before a session exists (e.g. while on /{slug}/new before
 * claimSession resolves) are buffered locally; placeholder upload chips appear
 * immediately and the actual POST is deferred until sessionId is available.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: drain deferred upload buffer when sessionId becomes available
import { useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { UploadedFile, UploadRef, UploadItem } from "../../server/shared/types.js";
import { useFileStore, markUploadDeleted } from "../stores/file-store.js";

export type { UploadItem, UploadStatus } from "../../server/shared/types.js";

interface UploadResponse {
  files: UploadedFile[];
}

let uploadIdCounter = 0;

export function useFileUpload(sessionId: string | undefined) {
  const pendingUploads = useFileStore(useShallow((s) => s.sessionUploads.filter((u) => u.pending)));

  // Files attached before a session exists. Each entry maps a File to the
  // placeholder UploadItem id created at attach time, so we can resolve to
  // "ready" status (and rewrite name/path/size from the server response) once
  // the session is ready and the POST completes.
  const deferredFilesRef = useRef<{ file: File; itemId: string }[]>([]);

  /** POST a batch of files; updates the existing UploadItems with server response. */
  const uploadToServer = useCallback(async (sid: string, files: File[], items: UploadItem[]) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append("file", file);
    }
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
          st.updateSessionUpload(items[i].id, {
            status: "ready",
            name: uploaded.name,
            path: uploaded.path,
            size: uploaded.size,
            progress: 100,
          });
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Upload failed";
      const st = useFileStore.getState();
      for (const item of items) {
        st.updateSessionUpload(item.id, { status: "error", error: errorMsg, progress: 0 });
      }
    }
  }, []);

  /**
   * Add files. Placeholder chips appear immediately; the upload POST runs as
   * soon as a session exists (buffered if not).
   */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const store = useFileStore.getState();

      // Create placeholder items (with thumbnail preview for images)
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

      // Read image files as data URLs for stable display in chat messages
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

      if (!sessionId) {
        // Defer — drained by the useEffect below when sessionId resolves
        for (let i = 0; i < files.length; i++) {
          deferredFilesRef.current.push({ file: files[i], itemId: items[i].id });
        }
        return;
      }

      await uploadToServer(sessionId, files, items);
    },
    [sessionId, uploadToServer],
  );

  // Drain the deferred buffer when a sessionId becomes available
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!sessionId || deferredFilesRef.current.length === 0) return;
    const queued = deferredFilesRef.current;
    deferredFilesRef.current = [];
    const all = useFileStore.getState().sessionUploads;
    const items: UploadItem[] = [];
    const files: File[] = [];
    for (const q of queued) {
      const item = all.find((u) => u.id === q.itemId);
      if (item) {
        items.push(item);
        files.push(q.file);
      }
    }
    if (files.length > 0) {
      void uploadToServer(sessionId, files, items);
    }
  }, [sessionId, uploadToServer]);

  /** Remove a pending upload by index and delete the file from the server. */
  const removeUpload = useCallback((index: number) => {
    const item = pendingUploads[index];
    if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item.path && sessionId) {
      const filename = item.path.replace(/^\/uploads\//, "");
      markUploadDeleted(item.path);
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/files/uploads/${encodeURIComponent(filename)}`, { method: "DELETE" });
          if (!res.ok) console.warn(`[upload] DELETE ${item.path} failed: ${res.status} ${res.statusText}`);
        } catch (err: unknown) {
          console.warn("[upload] DELETE failed:", err);
        }
      })();
      useFileStore.getState().removeSessionUpload(item.path);
    } else {
      useFileStore.getState().removeSessionUploadById(item.id);
    }
  }, [sessionId, pendingUploads]);

  /** Retry a failed upload — removes it, user can re-attach. */
  const retryUpload = useCallback((index: number) => {
    const item = pendingUploads[index];
    if (!item) return;
    useFileStore.getState().removeSessionUploadById(item.id);
  }, [pendingUploads]);

  /** Get pending ready uploads as UploadRef[] for send_message. */
  const getUploadRefs = useCallback((): UploadRef[] => {
    return pendingUploads
      .filter((u) => u.status === "ready" && u.path)
      .map((u) => ({ path: u.path!, type: "upload" as const }));
  }, [pendingUploads]);

  /** Mark all pending uploads as sent. */
  const clearUploads = useCallback(() => {
    useFileStore.getState().markUploadsSent();
  }, []);

  return {
    /** Pending uploads — shown as input chips, cleared on send. */
    uploads: pendingUploads,
    uploadFiles,
    removeUpload,
    retryUpload,
    getUploadRefs,
    clearUploads,
  };
}
