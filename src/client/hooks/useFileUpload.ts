/**
 * useFileUpload — manages file upload state (input chips) and upload API calls.
 * Session-level uploads (for file tree and @-autocomplete) are stored in the
 * file store (Zustand) so they survive route transitions.
 */

import { useState, useCallback } from "react";
import type { UploadedFile, UploadRef, UploadItem } from "../../server/shared/types.js";
import { useFileStore } from "../stores/file-store.js";

export type { UploadItem, UploadStatus } from "../../server/shared/types.js";

interface UploadResponse {
  files: UploadedFile[];
}

let uploadIdCounter = 0;

export function useFileUpload(sessionId: string | undefined) {
  /** Input chips — files being attached to the current message. Cleared on send. */
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  /** Upload files immediately via POST multipart. */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!sessionId || files.length === 0) return;

      // Create placeholder items (with thumbnail preview for images)
      const items: UploadItem[] = files.map((f) => ({
        id: `upload-${++uploadIdCounter}`,
        name: f.name,
        status: "uploading" as const,
        size: f.size,
        progress: 0,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      }));

      setUploads((prev) => [...prev, ...items]);

      // Build FormData
      const formData = new FormData();
      for (const file of files) {
        formData.append("file", file);
      }

      try {
        const res = await fetch(`/api/sessions/${sessionId}/files/uploads`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
          const errorMsg = body.error ?? res.statusText;
          setUploads((prev) =>
            prev.map((u) =>
              items.some((it) => it.id === u.id)
                ? { ...u, status: "error" as const, error: errorMsg, progress: 0 }
                : u,
            ),
          );
          return;
        }

        const data = (await res.json()) as UploadResponse;

        // Build a map from placeholder ID to completed upload item
        const readyMap = new Map<string, UploadItem>();
        for (let i = 0; i < items.length; i++) {
          const uploaded = data.files[i];
          if (uploaded) {
            readyMap.set(items[i].id, {
              ...items[i],
              status: "ready" as const,
              name: uploaded.name,
              path: uploaded.path,
              size: uploaded.size,
              progress: 100,
            });
          }
        }

        // Update input chips
        setUploads((prev) => prev.map((u) => readyMap.get(u.id) ?? u));
        // Add to session-level uploads (Zustand store) for file tree / @-autocomplete
        useFileStore.getState().addSessionUploads([...readyMap.values()]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Upload failed";
        setUploads((prev) =>
          prev.map((u) =>
            items.some((it) => it.id === u.id)
              ? { ...u, status: "error" as const, error: errorMsg, progress: 0 }
              : u,
          ),
        );
      }
    },
    [sessionId],
  );

  /** Remove an upload item by index and delete the file from the server. */
  const removeUpload = useCallback((index: number) => {
    setUploads((prev) => {
      const item = prev[index];
      if (item?.path && sessionId) {
        const filename = item.path.replace(/^\/uploads\//, "");
        void fetch(`/api/sessions/${sessionId}/files/uploads/${encodeURIComponent(filename)}`, {
          method: "DELETE",
        });
        // Also remove from session-level uploads (Zustand store)
        useFileStore.getState().removeSessionUpload(item.path);
      }
      return prev.filter((_, i) => i !== index);
    });
  }, [sessionId]);

  /** Retry a failed upload — removes it, user can re-attach. */
  const retryUpload = useCallback((index: number) => {
    setUploads((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /** Get ready uploads as UploadRef[] for send_message. */
  const getUploadRefs = useCallback((): UploadRef[] => {
    return uploads
      .filter((u) => u.status === "ready" && u.path)
      .map((u) => ({ path: u.path!, type: "upload" as const }));
  }, [uploads]);

  /** Clear all uploads (after message send). */
  const clearUploads = useCallback(() => {
    setUploads((prev) => {
      for (const u of prev) {
        if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      }
      return [];
    });
  }, []);

  const hasReadyUploads = uploads.some((u) => u.status === "ready");
  const isUploading = uploads.some((u) => u.status === "uploading");

  return {
    uploads,
    uploadFiles,
    removeUpload,
    retryUpload,
    getUploadRefs,
    clearUploads,
    hasReadyUploads,
    isUploading,
  };
}
