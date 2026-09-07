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
import { useFileStore, markUploadDeleted, clearUploadTombstone, noteUploadsChanged } from "./file-store.js";
import { useSessionStore } from "./session-store.js";
import { getSavedDraftUploads, saveDraftUploads } from "../utils/local-storage.js";
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
    // hydrateUploads scans chat history to self-heal the draft-uploads set;
    // start empty so a draft path is only pruned when a test adds a sent message.
    // `sessionId` is what these tests always meant: the session on screen is the
    // one being hydrated. docs/294 req 2 refuses a listing for any other, so
    // leaving it unset would drop every response here.
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

  describe("hydrateUploads draft restoration", () => {
    it("restores a chip for an attached-but-unsent file after a reload (memory empty)", async () => {
      // The file uploaded successfully (so it's on disk + in the draft set) but
      // the user reloaded before sending. The store is empty (reload), so the
      // chip can only come back from the persisted draft set.
      saveDraftUploads(SESSION_ID, ["/uploads/draft.png"]);
      stubUploadsFetch([uploaded("draft.png"), uploaded("leftover.csv")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      const draft = uploads.find((u) => u.path === "/uploads/draft.png");
      const leftover = uploads.find((u) => u.path === "/uploads/leftover.csv");
      expect(draft?.pending).toBe(true); // restored as a chip
      expect(leftover?.pending).toBe(false); // a non-drafted file stays panel-only
    });

    it("self-heals: a drafted path that chat history shows was sent is pruned, not shown as a chip", async () => {
      // Simulates a missed send-time removal: the path lingers in the draft set,
      // but the user message in chat history references it, so it was sent.
      saveDraftUploads(SESSION_ID, ["/uploads/sent.png"]);
      useSessionStore.setState({
        messages: [{ role: "user", text: "look at this", uploadPaths: ["/uploads/sent.png"] }],
      });
      stubUploadsFetch([uploaded("sent.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads[0].pending).toBe(false);
      // The stale draft entry is pruned from storage too.
      expect(getSavedDraftUploads(SESSION_ID)).toEqual([]);
    });

    it("shows no chip for a drafted path the server does not have", async () => {
      // docs/294 req 4 — this used to also DELETE the path from the draft set,
      // which made a snapshot authoritative over a file it could not know
      // about: another tab finishing an upload had its just-saved path erased
      // from shared localStorage. What matters is that no chip appears, and a
      // chip is built from the listing — so the path can simply stay.
      saveDraftUploads(SESSION_ID, ["/uploads/gone.png"]);
      stubUploadsFetch([uploaded("present.png")]);

      await useFileStore.getState().hydrateUploads(SESSION_ID);

      const uploads = useFileStore.getState().sessionUploads;
      expect(uploads.map((u) => u.path)).toEqual(["/uploads/present.png"]);
      expect(uploads[0].pending).toBe(false);
    });

    it("does not erase a draft path another tab saved while this listing was in flight", async () => {
      // The cross-tab case directly: the counters are per-tab, so nothing here
      // can see the other tab's upload. Not pruning on absence is what makes
      // that safe.
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
    // The listing deliberately does NOT contain the drafted file, so an applied
    // response would be visible in both assertions below rather than only one.
    stubUploadsFetch([uploaded("unrelated.png")]);

    await useFileStore.getState().hydrateUploads(OTHER_SESSION);

    expect(useFileStore.getState().sessionUploads).toEqual([]);
    // ...and it did not touch the other session's draft set on the way past.
    expect(getSavedDraftUploads(OTHER_SESSION)).toEqual(["/uploads/theirs.png"]);
  });

  it("refuses a listing superseded by a newer one, and does not refetch (req 3)", async () => {
    let calls = 0;
    const resolvers: (() => void)[] = [];
    globalThis.fetch = vi.fn(async () => {
      const mine = ++calls;
      await new Promise<void>((r) => resolvers.push(r));
      // The first (older) request answers with a file the second does not have.
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
    // The superseded one did not start a third request of its own.
    expect(calls).toBe(2);
  });

  it("refetches when an upload landed while the listing was in flight (req 1)", async () => {
    // The defect: this listing was requested before `late.png` existed, so it
    // prunes that path from the draft set and the chip is gone at next reload.
    saveDraftUploads(SESSION_ID, ["/uploads/late.png"]);
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      const mine = ++calls;
      if (mine === 1) {
        // An upload lands while this request is open.
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
    // req 4 — the attachment kept its place in the composer.
    expect(getSavedDraftUploads(SESSION_ID)).toEqual(["/uploads/late.png"]);
    expect(useFileStore.getState().sessionUploads[0].pending).toBe(true);
  });

  it("is not disturbed by a change in a session the user has left (req 1)", async () => {
    // The counter is keyed by session on purpose: an outgoing session's uploads
    // go on completing after a switch, and a global counter let those
    // completions invalidate the NEW session's perfectly current listing —
    // four in a row would exhaust the retry chain and leave its panel empty.
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
      // Out of date the moment it is produced — but only for a while. An
      // endless source would make an unbounded implementation hang the worker
      // instead of failing an assertion, and a crash is a worse guard than a
      // red test.
      if (calls <= 10) noteUploadsChanged(SESSION_ID);
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await useFileStore.getState().hydrateUploads(SESSION_ID);
    // Let the chain run itself out, then confirm it stopped rather than sampling
    // a window it might merely not have filled yet.
    await new Promise((r) => setTimeout(r, 100));
    const settled = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBe(settled);
    // The first request plus exactly MAX_HYDRATE_REFETCHES more.
    expect(calls).toBe(4);
  });
});
