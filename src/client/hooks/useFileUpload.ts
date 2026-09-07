/**
 * useFileUpload — manages file upload API calls.
 * All upload state lives in the file store (Zustand) so it survives page reloads.
 * Pending uploads (not yet sent in a message) are shown as input chips.
 *
 * Files attached before a session exists (e.g. while on /{slug}/new before
 * claimSession resolves) show a placeholder chip immediately; the POST runs as
 * soon as a sessionId arrives. The bytes waiting for it live beside the store
 * (`retainUploadBytes`, docs/293), not in this hook — see the resume pass below
 * for why that difference matters.
 */

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
    if (!res.ok) console.warn(`[upload] DELETE ${uploadPath} failed: ${res.status} ${res.statusText}`);
  } catch (err: unknown) {
    console.warn("[upload] DELETE failed:", err);
  } finally {
    // docs/294 req 1 — bumped on COMPLETION, not before the request: the point
    // is "the server's set is now different", and a listing that started while
    // the DELETE was still open would otherwise pass its freshness check with a
    // file that has since gone.
    noteUploadsChanged(sessionId);
  }
}

export function useFileUpload(sessionId: string | undefined) {
  const pendingUploads = useFileStore(useShallow((s) => s.sessionUploads.filter((u) => u.pending)));

  /** POST a batch of files; updates the existing UploadItems with server response. */
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
      // docs/294 req 1 — the server holds something it did not a moment ago, so
      // any listing already in flight is describing a world without it.
      noteUploadsChanged(sid);
      const st = useFileStore.getState();
      for (let i = 0; i < items.length; i++) {
        const uploaded = data.files[i];
        if (uploaded) {
          // docs/293 req 7 — the chip may be gone: Remove is available while an
          // upload is in flight, and the request goes on regardless. Recording a
          // draft for it would have `hydrateUploads` restore the attachment the
          // user explicitly dismissed, onto a later message. Delete the file the
          // server did save rather than leaving it orphaned.
          if (!st.sessionUploads.some((u) => u.id === items[i].id)) {
            releaseUploadBytes(items[i].id);
            // Tombstone it as well as deleting it: a listing already in flight
            // can contain this file, and without the tombstone hydration would
            // restore the attachment the user dismissed into the panel.
            markUploadDeleted(uploaded.path);
            void deleteUploadFromServer(sid, uploaded.path);
            continue;
          }
          // A fresh upload supersedes any stale tombstone for its path. Without
          // this, re-uploading a same-named file (server reuses the name via
          // deduplicateFilename) leaves a prior delete's tombstone in place, and
          // hydrateUploads filters the new file out on the next reconnect.
          clearUploadTombstone(uploaded.path);
          // Record the attached-but-unsent path so the chip survives a reload /
          // session switch (mirrors how the composer's draft text is persisted).
          // hydrateUploads self-heals this set against chat history, so a path
          // left here after the file is sent never resurrects a chip.
          addDraftUpload(sid, uploaded.path);
          st.updateSessionUpload(items[i].id, {
            status: "ready",
            name: uploaded.name,
            path: uploaded.path,
            size: uploaded.size,
            progress: 100,
          });
          // The bytes are on the server now — a retry would re-POST a duplicate.
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
      for (let i = 0; i < files.length; i++) {
        retainUploadBytes(items[i].id, files[i]);
      }

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

      // No session yet (the /{slug}/new view before claimSession resolves): the
      // bytes are already retained above and the items read "uploading", which is
      // exactly what the resume pass below looks for.
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

  /** Remove a pending upload by index and delete the file from the server. */
  const removeUpload = useCallback((index: number) => {
    const item = pendingUploads[index];
    if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (item.path && sessionId) {
      markUploadDeleted(item.path);
      // The user dismissed the chip before sending — drop it from the draft set
      // so it isn't restored on the next reload.
      removeDraftUploads(sessionId, [item.path]);
      void deleteUploadFromServer(sessionId, item.path);
      useFileStore.getState().removeSessionUpload(item.path);
    } else {
      useFileStore.getState().removeSessionUploadById(item.id);
    }
  }, [sessionId, pendingUploads]);

  /**
   * docs/293 req 3 — re-POST a failed upload's bytes. This used to remove the
   * chip, which read as "Retry deleted my attachment"; with req 2 blocking Send
   * on a failed upload it would also have cleared the block by discarding the
   * very thing the block protects.
   *
   * Only a failed chip is retryable. A `ready` one has had its bytes released
   * deliberately (re-POSTing them would duplicate the file on the server, not
   * replace it), and an `uploading` one already has a request — its own, or the
   * resume pass's. Where the bytes are somehow absent the chip is left failed
   * rather than deleted: Remove is the explicit way to drop an attachment, and
   * it is available on every chip.
   */
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
    // No session yet: the chip now reads "uploading" with its bytes retained,
    // which is exactly what the resume pass picks up when one arrives.
    if (!sessionId) return;
    void uploadToServer(sessionId, [file], [retried]);
  }, [pendingUploads, sessionId, uploadToServer]);

  /** Get pending ready uploads as UploadRef[] for send_message. */
  const getUploadRefs = useCallback((): UploadRef[] => {
    return pendingUploads
      .filter((u) => u.status === "ready" && u.path)
      .map((u) => ({ path: u.path!, type: "upload" as const }));
  }, [pendingUploads]);

  /** Mark all pending uploads as sent (clears the input chips). */
  const clearUploads = useCallback(() => {
    const sentPaths = pendingUploads.map((u) => u.path).filter((p): p is string => Boolean(p));
    // `markUploadsSent` releases the retained bytes with the chips.
    useFileStore.getState().markUploadsSent();
    // These paths are now sent, so they're no longer a draft. Removing them
    // keeps the draft set tight; hydrateUploads would also prune them against
    // chat history, so a missed removal here can't leave a stale chip.
    if (sessionId) removeDraftUploads(sessionId, sentPaths);
  }, [pendingUploads, sessionId]);

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
