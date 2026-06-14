/**
 * Unit tests for the upload tombstone guard in useFileStore.
 *
 * Covers the `deletedUploads` localStorage tombstone (`markUploadDeleted` /
 * `clearUploadTombstone`) and how `hydrateUploads` filters the server upload
 * list against it.
 *
 * Regression: a fresh upload whose path matches a *stale* tombstone (same name
 * re-uploaded after a delete — the server reuses the name via
 * `deduplicateFilename`) used to be present on the server, so the tombstone was
 * not pruned, and `hydrateUploads` filtered the freshly-uploaded file out on the
 * next reconnect/session load. Clearing the tombstone on upload success
 * (`clearUploadTombstone`) is what keeps the file visible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useFileStore, markUploadDeleted, clearUploadTombstone } from "./file-store.js";
import type { UploadItem, UploadedFile } from "../../server/shared/types.js";

const DELETED_UPLOADS_KEY = "shipit:deletedUploads";
const SESSION_ID = "session-1";

function uploaded(name: string): UploadedFile {
  return { name, path: `/uploads/${name}`, size: 123, type: "upload" };
}

/** Stub `fetch` so `hydrateUploads`'s GET /files/uploads returns `files`. */
function stubUploadsFetch(files: UploadedFile[]) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ files }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("file-store upload tombstones", () => {
  beforeEach(() => {
    localStorage.clear();
    useFileStore.getState().reset();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("clearUploadTombstone", () => {
    it("removes a single path and leaves others intact", () => {
      markUploadDeleted("/uploads/a.png");
      markUploadDeleted("/uploads/b.png");
      clearUploadTombstone("/uploads/a.png");
      const remaining = JSON.parse(localStorage.getItem(DELETED_UPLOADS_KEY) ?? "[]") as string[];
      expect(remaining).toEqual(["/uploads/b.png"]);
    });

    it("clears the localStorage key entirely when the set empties", () => {
      markUploadDeleted("/uploads/a.png");
      clearUploadTombstone("/uploads/a.png");
      expect(localStorage.getItem(DELETED_UPLOADS_KEY)).toBeNull();
    });

    it("is a no-op for a path that was never tombstoned", () => {
      markUploadDeleted("/uploads/a.png");
      clearUploadTombstone("/uploads/missing.png");
      const remaining = JSON.parse(localStorage.getItem(DELETED_UPLOADS_KEY) ?? "[]") as string[];
      expect(remaining).toEqual(["/uploads/a.png"]);
    });
  });

  describe("hydrateUploads deletedPaths filter", () => {
    it("drops a server upload whose path is still tombstoned", async () => {
      // A stale tombstone for a path the server still reports — the failed-DELETE
      // case the tombstone is designed for.
      markUploadDeleted("/uploads/data.csv");
      stubUploadsFetch([uploaded("data.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      expect(useFileStore.getState().sessionUploads).toHaveLength(0);
    });

    it("retains a freshly re-uploaded file once its tombstone is cleared", async () => {
      // Repro of the reported bug: upload data.csv → delete it (tombstone written)
      // → re-upload a same-named file. The upload success handler calls
      // clearUploadTombstone, so the file must survive the next hydrate.
      markUploadDeleted("/uploads/data.csv");
      clearUploadTombstone("/uploads/data.csv"); // <-- what upload success does
      stubUploadsFetch([uploaded("data.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads).toHaveLength(1);
      expect(uploads[0].path).toBe("/uploads/data.csv");
      // A file present on disk is already handled (sent or left over); hydration
      // surfaces it in the /uploads panel but never as an input chip.
      expect(uploads[0].pending).toBe(false);
    });

    it("prunes a tombstone whose file is gone from the server, keeping unrelated files", async () => {
      // Existing prune path: tombstone for a path absent from the server list is
      // dropped, and other server files hydrate normally.
      markUploadDeleted("/uploads/gone.png");
      stubUploadsFetch([uploaded("present.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      expect(useFileStore.getState().sessionUploads.map((u) => u.path)).toEqual([
        "/uploads/present.png",
      ]);
      // The stale tombstone for the now-absent file is cleaned up.
      expect(localStorage.getItem(DELETED_UPLOADS_KEY)).toBeNull();
    });
  });

  describe("hydrateUploads pending semantics", () => {
    function pendingUpload(name: string): UploadItem {
      return {
        id: `mem-${name}`,
        name,
        status: "ready",
        path: `/uploads/${name}`,
        progress: 100,
        pending: true,
      };
    }

    it("never resurrects a chip from disk — every hydrated file is non-pending", async () => {
      // The reported bug: a file sent in a prior turn stays in /uploads and used
      // to reappear as an input chip after a reload/reconnect. It must not.
      stubUploadsFetch([uploaded("sent.png"), uploaded("old.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads).toHaveLength(2);
      expect(uploads.every((u) => u.pending === false)).toBe(true);
    });

    it("preserves an in-memory pending upload (attached, not yet sent) across hydrate", async () => {
      // A WS reconnect keeps the Zustand store, so a freshly-attached-but-unsent
      // chip must survive hydration even though its file is already on disk.
      useFileStore.getState().addSessionUploads([pendingUpload("draft.png")]);
      stubUploadsFetch([uploaded("draft.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      // Exactly one entry for the path — the in-memory pending item is kept and
      // the server copy is not duplicated.
      expect(uploads.filter((u) => u.path === "/uploads/draft.png")).toHaveLength(1);
      expect(uploads[0].id).toBe("mem-draft.png");
      expect(uploads[0].pending).toBe(true);
    });

    it("markUploadsSent clears pending so the chip disappears but the file remains", () => {
      useFileStore.getState().addSessionUploads([pendingUpload("note.txt")]);

      useFileStore.getState().markUploadsSent();

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads).toHaveLength(1);
      expect(uploads[0].pending).toBe(false);
    });
  });
});
