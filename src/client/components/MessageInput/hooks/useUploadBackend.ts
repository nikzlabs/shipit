// eslint-disable-next-line no-restricted-imports -- useEffect: revoke object URLs when the chip set churns
import { useCallback, useEffect, useMemo, useState } from "react";
import { useFileStore } from "../../../stores/file-store.js";
import { useFileUpload } from "../../../hooks/useFileUpload.js";
import type { UploadItem } from "../../../hooks/useFileUpload.js";
import type { UploadRef } from "../../../../server/shared/types.js";

export interface UploadBackend {
  isOverlay: boolean;
  /** Raw File objects buffered in overlay mode (empty in chat mode). */
  localFiles: File[];
  /** Chips to render for this composer (session uploads or local placeholders). */
  displayUploads: UploadItem[];
  /** All uploads visible to autocomplete (global store in chat mode). */
  allUploads: UploadItem[];
  handleAddFiles: (files: File[]) => void;
  handleRemoveUploadChip: (index: number) => void;
  handleRetryUploadChip: (index: number) => void;
  /** Upload refs at send time — already-POSTed paths in chat mode, [] in overlay. */
  getUploadRefs: () => UploadRef[];
  /** Clear upload state after a successful send. */
  clearUploads: () => void;
}

/**
 * Two upload backends share the same surface (chip rendering, +/drop-zone,
 * submit clear). The split is by `surface`, not by `sessionId` presence:
 *   - "chat":   route through `useFileUpload(sessionId)`. POSTs land in the
 *               global file-store; when sessionId is temporarily undefined
 *               (the /{slug}/new view, before claimSession resolves),
 *               useFileUpload buffers and drains on its own.
 *   - "overlay": buffer raw Files in component-local state. The overlay creates
 *                a brand-new session on send and ships the files multipart in
 *                the same call, so the global store must stay untouched — a chat
 *                input is still mounted behind the modal and would otherwise
 *                sprout phantom chips.
 * `useFileUpload` is always called (hooks rule); in overlay mode we just never
 * invoke its `uploadFiles`, so no store writes happen.
 */
export function useUploadBackend({
  surface,
  sessionId,
}: {
  surface: "chat" | "overlay";
  sessionId?: string;
}): UploadBackend {
  const isOverlay = surface === "overlay";
  const sessionUpload = useFileUpload(isOverlay ? undefined : sessionId);
  const allSessionUploads = useFileStore((s) => s.sessionUploads);
  const [localFiles, setLocalFiles] = useState<File[]>([]);

  // Map raw Files into UploadItem placeholders so the chip renderer treats
  // both modes identically. Status is "ready" — no progress bar, no retry,
  // since these are kept entirely local until the parent ships them.
  const localUploadItems = useMemo<UploadItem[]>(
    () =>
      localFiles.map((f, i) => ({
        id: `local-${i}-${f.name}`,
        name: f.name,
        status: "ready" as const,
        size: f.size,
        progress: 100,
        previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
        mimeType: f.type.startsWith("image/") ? f.type : undefined,
        pending: true,
      })),
    [localFiles],
  );
  // Revoke object URLs when the chip set churns to keep memory bounded.
  // We can't derive this — URL.revokeObjectURL is a browser-side side effect
  // that must happen when the item leaves the set, not during render.
  // eslint-disable-next-line no-restricted-syntax -- browser API cleanup tied to item lifetime
  useEffect(() => {
    const items = localUploadItems;
    return () => {
      for (const item of items) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, [localUploadItems]);

  const displayUploads = isOverlay ? localUploadItems : sessionUpload.uploads;
  const allUploads = isOverlay ? localUploadItems : allSessionUploads;

  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (isOverlay) {
        setLocalFiles((prev) => [...prev, ...files]);
      } else {
        void sessionUpload.uploadFiles(files);
      }
    },
    [isOverlay, sessionUpload],
  );

  const handleRemoveUploadChip = useCallback(
    (index: number) => {
      if (isOverlay) {
        setLocalFiles((prev) => prev.filter((_, i) => i !== index));
      } else {
        sessionUpload.removeUpload(index);
      }
    },
    [isOverlay, sessionUpload],
  );

  const handleRetryUploadChip = useCallback(
    (index: number) => {
      if (!isOverlay) sessionUpload.retryUpload(index);
      // Overlay-mode retry is a no-op — local items never enter an error state.
    },
    [isOverlay, sessionUpload],
  );

  const getUploadRefs = useCallback(
    () => (isOverlay ? [] : sessionUpload.getUploadRefs()),
    [isOverlay, sessionUpload],
  );

  const clearUploads = useCallback(() => {
    if (isOverlay) {
      setLocalFiles([]);
    } else {
      sessionUpload.clearUploads();
    }
  }, [isOverlay, sessionUpload]);

  return {
    isOverlay,
    localFiles,
    displayUploads,
    allUploads,
    handleAddFiles,
    handleRemoveUploadChip,
    handleRetryUploadChip,
    getUploadRefs,
    clearUploads,
  };
}
