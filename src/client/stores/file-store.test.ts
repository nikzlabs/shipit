

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useFileStore, markUploadDeleted, clearUploadTombstone, noteUploadsChanged } from "./file-store.js";
import { useSessionStore } from "./session-store.js";
import { getSavedDraftUploads, saveDraftUploads } from "../utils/local-storage.js";
import type { UploadItem, UploadedFile } from "../../server/shared/types.js";

const DELETED_UPLOADS_KEY = "shipit:deletedUploads";
const SESSION_ID = "session-1";

function uploaded(name: string): UploadedFile {
  return { name, path: `/uploads/${name}`, size: 123, type: "upload" };
}

function stubUploadsFetch(files: UploadedFile[]) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ files }), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe("file-store upload tombstones", () => {
  beforeEach(() => {
    localStorage.clear();
    useFileStore.getState().reset();

    useSessionStore.setState({ messages: [], sessionId: SESSION_ID });
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

      markUploadDeleted("/uploads/data.csv");
      stubUploadsFetch([uploaded("data.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      expect(useFileStore.getState().sessionUploads).toHaveLength(0);
    });

    it("retains a freshly re-uploaded file once its tombstone is cleared", async () => {

      // clearUploadTombstone, so the file must survive the next hydrate.
      markUploadDeleted("/uploads/data.csv");
      clearUploadTombstone("/uploads/data.csv");                                
      stubUploadsFetch([uploaded("data.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads).toHaveLength(1);
      expect(uploads[0].path).toBe("/uploads/data.csv");

      // surfaces it in the /uploads panel but never as an input chip.
      expect(uploads[0].pending).toBe(false);
    });

    it("prunes a tombstone whose file is gone from the server, keeping unrelated files", async () => {

      markUploadDeleted("/uploads/gone.png");
      stubUploadsFetch([uploaded("present.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      expect(useFileStore.getState().sessionUploads.map((u) => u.path)).toEqual([
        "/uploads/present.png",
      ]);

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

      // to reappear as an input chip after a reload/reconnect. It must not.
      stubUploadsFetch([uploaded("sent.png"), uploaded("old.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads).toHaveLength(2);
      expect(uploads.every((u) => u.pending === false)).toBe(true);
    });

    it("preserves an in-memory pending upload (attached, not yet sent) across hydrate", async () => {

      // chip must survive hydration even though its file is already on disk.
      useFileStore.getState().addSessionUploads([pendingUpload("draft.png")]);
      stubUploadsFetch([uploaded("draft.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;

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

  describe("hydrateUploads draft restoration", () => {
    it("restores a chip for an attached-but-unsent file after a reload (memory empty)", async () => {

      saveDraftUploads(SESSION_ID, ["/uploads/draft.png"]);
      stubUploadsFetch([uploaded("draft.png"), uploaded("leftover.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      const draft = uploads.find((u) => u.path === "/uploads/draft.png");
      const leftover = uploads.find((u) => u.path === "/uploads/leftover.csv");
      expect(draft?.pending).toBe(true);                      
      expect(leftover?.pending).toBe(false);                                       
    });

    it("self-heals: a drafted path that chat history shows was sent is pruned, not shown as a chip", async () => {

      saveDraftUploads(SESSION_ID, ["/uploads/sent.png"]);
      useSessionStore.setState({
        messages: [{ role: "user", text: "look at this", uploadPaths: ["/uploads/sent.png"] }],
      });
      stubUploadsFetch([uploaded("sent.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads[0].pending).toBe(false);

      expect(getSavedDraftUploads(SESSION_ID)).toEqual([]);
    });

    it("shows no chip for a drafted path the server does not have", async () => {

      saveDraftUploads(SESSION_ID, ["/uploads/gone.png"]);
      stubUploadsFetch([uploaded("present.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads.map((u) => u.path)).toEqual(["/uploads/present.png"]);
      expect(uploads[0].pending).toBe(false);
    });

    it("does not erase a draft path another tab saved while this listing was in flight", async () => {

      saveDraftUploads(SESSION_ID, ["/uploads/theirs.png"]);
      stubUploadsFetch([uploaded("mine.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      expect(getSavedDraftUploads(SESSION_ID)).toEqual(["/uploads/theirs.png"]);
    });
  });
});

/**
 * docs/294 reqs 1-4 — an upload listing is a snapshot, and `hydrateUploads`
 * treats it as authority: it prunes the persisted draft set and rebuilds every
 * non-pending chip. An answer that is no longer current must not get that
 * authority, because the damage is invisible — `pendingInMemory` keeps the chip
 * on screen and the attachment is only missing at the next reload.
 */
describe("hydrateUploads — an out-of-date listing is never applied", () => {
  const OTHER_SESSION = "session-2";

  beforeEach(() => {
    localStorage.clear();
    useFileStore.getState().reset();
    useSessionStore.setState({ messages: [], sessionId: SESSION_ID });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("refuses a listing for a session the user has left (req 2)", async () => {

    saveDraftUploads(OTHER_SESSION, ["/uploads/theirs.png"]);
    stubUploadsFetch([uploaded("theirs.png")]);

    await useFileStore.getState().hydrateUploads(OTHER_SESSION);

    expect(useFileStore.getState().sessionUploads).toEqual([]);
  });

  it("refuses a listing superseded by a newer one, and does not refetch (req 3)", async () => {
    let calls = 0;
    const resolvers: (() => void)[] = [];
    globalThis.fetch = vi.fn(async () => {
      const mine = ++calls;
      await new Promise<void>((r) => resolvers.push(r));

      return new Response(
        JSON.stringify({ files: mine === 1 ? [uploaded("old.png")] : [uploaded("new.png")] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = useFileStore.getState().hydrateUploads(SESSION_ID);
    const second = useFileStore.getState().hydrateUploads(SESSION_ID);
    // Let the OLDER one answer last — the race this guards.
    resolvers[1]();
    resolvers[0]();
    await Promise.all([first, second]);

    const names = useFileStore.getState().sessionUploads.map((u) => u.name);
    expect(names).toEqual(["new.png"]);

    expect(calls).toBe(2);
  });

  it("refetches when an upload landed while the listing was in flight (req 1)", async () => {

    saveDraftUploads(SESSION_ID, ["/uploads/late.png"]);
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      const mine = ++calls;
      if (mine === 1) {

        noteUploadsChanged(SESSION_ID);
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [uploaded("late.png")] }), { status: 200 });
    }) as unknown as typeof fetch;

    await useFileStore.getState().hydrateUploads(SESSION_ID);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() =>
      expect(useFileStore.getState().sessionUploads.map((u) => u.name)).toEqual(["late.png"]),
    );

    expect(getSavedDraftUploads(SESSION_ID)).toEqual(["/uploads/late.png"]);
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(true);
  });

  it("is not disturbed by a change in a session the user has left (req 1)", async () => {

    let listings = 0;
    globalThis.fetch = vi.fn(async () => {
      listings++;
      noteUploadsChanged(OTHER_SESSION);
      return new Response(JSON.stringify({ files: [uploaded("mine.png")] }), { status: 200 });
    }) as unknown as typeof fetch;

    await useFileStore.getState().hydrateUploads(SESSION_ID);

    expect(listings).toBe(1);
    expect(useFileStore.getState().sessionUploads.map((u) => u.name)).toEqual(["mine.png"]);
  });

  it("gives up refetching rather than chasing a churning session (req 1)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;

      if (calls <= 10) noteUploadsChanged(SESSION_ID);
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await useFileStore.getState().hydrateUploads(SESSION_ID);

    await new Promise((r) => setTimeout(r, 100));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(settled);

    expect(calls).toBe(4);
  });
});
