/**
 * useFileUpload — manages file upload state, upload API calls,
 * and reconnect hydration from the list endpoint.
 */

import { useState, useCallback } from "react";
import type { UploadedFile, UploadRef } from "../../server/shared/types.js";

export type UploadStatus = "uploading" | "ready" | "error";

export interface UploadItem {
  /** Client-side ID for tracking. */
  id: string;
  /** Original filename. */
  name: string;
  /** Upload status. */
  status: UploadStatus;
  /** File size in bytes (set once upload completes). */
  size?: number;
  /** Container path (set once upload completes). */
  path?: string;
  /** Error message if upload failed. */
  error?: string;
  /** Upload progress 0-100. */
  progress: number;
}

interface UploadResponse {
  files: UploadedFile[];
}

let uploadIdCounter = 0;

export function useFileUpload(sessionId: string | undefined) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  /** Upload files immediately via POST multipart. */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!sessionId || files.length === 0) return;

      // Create placeholder items
      const items: UploadItem[] = files.map((f) => ({
        id: `upload-${++uploadIdCounter}`,
        name: f.name,
        status: "uploading" as const,
        size: f.size,
        progress: 0,
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

        // Match response files to our items by index
        setUploads((prev) =>
          prev.map((u) => {
            const idx = items.findIndex((it) => it.id === u.id);
            if (idx === -1) return u;
            const uploaded = data.files[idx];
            if (!uploaded) return { ...u, status: "error" as const, error: "Missing response", progress: 0 };
            return {
              ...u,
              status: "ready" as const,
              name: uploaded.name,
              path: uploaded.path,
              size: uploaded.size,
              progress: 100,
            };
          }),
        );
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
    setUploads([]);
  }, []);

  /** Hydrate uploads from the list endpoint (for reconnection). */
  const hydrateUploads = useCallback(
    async (sid: string) => {
      try {
        const res = await fetch(`/api/sessions/${sid}/files/uploads`);
        if (!res.ok) return;
        const data = (await res.json()) as UploadResponse;
        if (data.files.length > 0) {
          setUploads(
            data.files.map((f) => ({
              id: `hydrated-${++uploadIdCounter}`,
              name: f.name,
              status: "ready" as const,
              size: f.size,
              path: f.path,
              progress: 100,
            })),
          );
        }
      } catch {
        // Hydration failure is non-critical
      }
    },
    [],
  );

  const hasReadyUploads = uploads.some((u) => u.status === "ready");
  const isUploading = uploads.some((u) => u.status === "uploading");

  return {
    uploads,
    uploadFiles,
    removeUpload,
    retryUpload,
    getUploadRefs,
    clearUploads,
    hydrateUploads,
    hasReadyUploads,
    isUploading,
  };
}
