/**
 * docs/293 req 3 — "Retry" on a failed upload re-POSTs the bytes. It used to
 * remove the chip, which with req 2 (a failed upload blocks Send) would have
 * cleared the block by discarding the attachment the block protects.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { StrictMode } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileUpload, deleteUploadFromServer } from "./useFileUpload.js";
import {
  useFileStore,
  getUploadBytes,
  forgetPendingUploads,
} from "../stores/file-store.js";
import { getSavedDraftUploads } from "../utils/local-storage.js";
import { useSessionStore } from "../stores/session-store.js";

/** A fetch stub whose POSTs hang until the returned `release` is called. */
function gatedUploads() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return { ok: true, json: async () => ({ files: [] }) };
    posts += 1;
    await gate;
    return {
      ok: true,
      json: async () => ({ files: [{ name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" }] }),
    };
  }));
  return { get posts() { return posts; }, release: () => release?.() };
}

const SESSION = "session-1";

/** Stub `fetch` so the first N upload POSTs fail and the rest succeed. */
function stubUploads({ failFirst }: { failFirst: number }) {
  let posts = 0;
  const bodies: FormData[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      bodies.push(init.body as FormData);
      if (posts <= failFirst) {
        return { ok: false, statusText: "Service Unavailable", json: async () => ({ error: "boom" }) };
      }
      return {
        ok: true,
        json: async () => ({ files: [{ name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" }] }),
      };
    }
    return { ok: true, json: async () => ({ files: [] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { get posts() { return posts; }, bodies };
}

beforeEach(() => {
  useFileStore.setState({ sessionUploads: [] });
  forgetPendingUploads();
  // Draft-upload paths are localStorage-backed, so an earlier test's successful
  // upload would otherwise satisfy a later test's draft assertion.
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useFileUpload.retryUpload", () => {
  it("re-POSTs the same bytes instead of removing the chip", async () => {
    const server = stubUploads({ failFirst: 1 });
    const { result } = renderHook(() => useFileUpload(SESSION));

    const file = new File(["hi!!"], "notes.txt", { type: "text/plain" });
    await act(async () => { await result.current.uploadFiles([file]); });

    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));

    act(() => { result.current.retryUpload(0); });

    // The chip survives the retry — this is the whole defect.
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.getUploadRefs()).toEqual([
      { path: "/uploads/notes.txt", type: "upload" },
    ]);
    expect(server.posts).toBe(2);
    // The retry carried the same bytes, not just a file of the same name.
    const resent = server.bodies[1].get("file") as File;
    expect(resent.name).toBe("notes.txt");
    expect(await resent.text()).toBe("hi!!");
  });

  it("clears the error so a retried chip stops blocking Send", async () => {
    stubUploads({ failFirst: 1 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));
    expect(result.current.uploads[0]?.error).toBe("boom");

    act(() => { result.current.retryUpload(0); });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(result.current.uploads[0]?.error).toBeUndefined();
  });

  it("can retry more than once", async () => {
    const server = stubUploads({ failFirst: 2 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));

    act(() => { result.current.retryUpload(0); });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));
    act(() => { result.current.retryUpload(0); });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(3);
  });

  it("does not re-POST an upload that already succeeded", async () => {
    // The bytes are dropped on success, so a retry there would duplicate the
    // file on the server rather than replace it.
    const server = stubUploads({ failFirst: 0 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));

    act(() => { result.current.retryUpload(0); });
    expect(server.posts).toBe(1);
    // ...and it does not delete the chip either, which is what it used to do.
    expect(result.current.uploads).toHaveLength(1);
  });

  it("still retries after the hook is remounted", async () => {
    // The chips are store state; the hook is remounted whenever the layout
    // crosses the mobile breakpoint. When the bytes lived in the hook, the
    // replacement had none and Retry deleted the attachment.
    const server = stubUploads({ failFirst: 1 });
    const first = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await first.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(first.result.current.uploads[0]?.status).toBe("error"));
    first.unmount();

    const second = renderHook(() => useFileUpload(SESSION));
    expect(second.result.current.uploads).toHaveLength(1);
    act(() => { second.result.current.retryUpload(0); });
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(2);
  });
});

describe("useFileUpload — resuming an upload nobody is driving", () => {
  it("uploads a chip attached before the session existed", async () => {
    const server = stubUploads({ failFirst: 0 });
    const { result, rerender } = renderHook(({ sid }) => useFileUpload(sid), {
      initialProps: { sid: undefined as string | undefined },
    });
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    expect(server.posts).toBe(0);
    expect(result.current.uploads[0]?.status).toBe("uploading");

    rerender({ sid: SESSION });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(1);
  });

  it("resumes an upload whose hook went away before the POST started", async () => {
    // Without this the chip sat at "uploading" forever: the queue that would
    // have started it belonged to a hook that no longer exists, Retry only
    // exists for errors, and docs/293 req 1 bars Send while anything uploads.
    const server = stubUploads({ failFirst: 0 });
    const first = renderHook(({ sid }) => useFileUpload(sid), {
      initialProps: { sid: undefined as string | undefined },
    });
    await act(async () => {
      await first.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    expect(server.posts).toBe(0);
    first.unmount();

    // The replacement hook mounts with a session — and finishes the job.
    const second = renderHook(() => useFileUpload(SESSION));
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(1);
  });

  it("does NOT restart an upload whose request is still running", async () => {
    // Unmounting does not cancel the `fetch`: it runs to completion and still
    // writes to the store. A replacement hook that re-POSTed would put two
    // copies on the server, and whichever landed first would release the bytes —
    // leaving the other's failure on a chip Retry could no longer fix.
    const server = gatedUploads();
    const first = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void first.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(server.posts).toBe(1));

    // Remount with the request still open — what crossing the mobile breakpoint
    // does mid-upload.
    first.unmount();
    const second = renderHook(() => useFileUpload(SESSION));
    await act(async () => { await Promise.resolve(); });
    expect(server.posts).toBe(1);

    // The original request still lands, and the surviving hook sees the result.
    await act(async () => { server.release(); await Promise.resolve(); });
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(1);
  });

  it("does not re-POST a chip whose upload is already in flight", async () => {
    // React StrictMode (on in `main.tsx`) double-invokes mount effects, so the
    // resume pass runs twice over the same "uploading" chip. Without the
    // in-flight guard that is two POSTs for one attachment in development.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return { ok: true, json: async () => ({ files: [] }) };
      posts += 1;
      await gate;
      return {
        ok: true,
        json: async () => ({ files: [{ name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" }] }),
      };
    }));

    // Attach with no session, so the chip is left for the resume pass...
    const attach = renderHook(() => useFileUpload(undefined));
    await act(async () => {
      await attach.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    expect(posts).toBe(0);
    attach.unmount();

    // ...then mount the real thing under StrictMode, which fires it twice.
    const { result } = renderHook(() => useFileUpload(SESSION), { wrapper: StrictMode });
    await waitFor(() => expect(posts).toBe(1));
    expect(posts).toBe(1);

    await act(async () => { release?.(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(posts).toBe(1);
  });
});

describe("useFileUpload — retained bytes do not outlive their chips", () => {
  it("releases the bytes when the chips are cleared on a session switch", async () => {
    stubUploads({ failFirst: 1 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));
    const id = result.current.uploads[0].id;
    expect(getUploadBytes(id)).toBeDefined();

    // What `switchSession` does while the composer stays mounted.
    act(() => { useFileStore.getState().reset(); });
    expect(getUploadBytes(id)).toBeUndefined();
  });

  it("releases the bytes when a single chip is removed", async () => {
    stubUploads({ failFirst: 1 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("error"));
    const id = result.current.uploads[0].id;

    act(() => { result.current.removeUpload(0); });
    expect(getUploadBytes(id)).toBeUndefined();
    expect(result.current.uploads).toHaveLength(0);
  });

});

describe("useFileUpload — an upload removed mid-flight stays removed", () => {
  it("records no draft and deletes the file the server saved (docs/293 req 7)", async () => {
    // Remove is available while an upload is in flight, and the request goes on
    // regardless. Recording a draft for a chip the user dismissed had
    // `hydrateUploads` restore it onto a later message.
    const deletes: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deletes.push(url); return { ok: true, json: async () => ({}) }; }
      if (init?.method !== "POST") return { ok: true, json: async () => ({ files: [] }) };
      await gate;
      return {
        ok: true,
        json: async () => ({ files: [{ name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" }] }),
      };
    }));

    const { result } = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads).toHaveLength(1));

    // Dismiss it while the POST is still open.
    act(() => { result.current.removeUpload(0); });
    expect(result.current.uploads).toHaveLength(0);

    await act(async () => { release?.(); await Promise.resolve(); });
    await waitFor(() => expect(deletes.some((u) => u.includes("notes.txt"))).toBe(true));
    // It does not come back, and nothing was recorded that could bring it back.
    expect(result.current.uploads).toHaveLength(0);
    expect(getSavedDraftUploads(SESSION)).not.toContain("/uploads/notes.txt");
  });
});

/**
 * docs/294 req 1 — these drive the REAL writers. The store's own tests bump the
 * counter from inside their fetch stub, so every production `noteUploadsChanged`
 * call could be deleted and they would stay green. These would not.
 */
describe("useFileUpload — a write invalidates a listing already in flight", () => {
  beforeEach(() => {
    useSessionStore.setState({ messages: [], sessionId: SESSION });
  });

  it("a landing upload makes an older listing refetch", async () => {
    let listings = 0;
    let releaseListing: (() => void) | undefined;
    const listingGate = new Promise<void>((r) => { releaseListing = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ files: [{ name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" }] }),
        };
      }
      if (url.includes("/files/uploads")) {
        listings += 1;
        // The first listing is held open while the upload lands under it.
        if (listings === 1) await listingGate;
        return { ok: true, json: async () => ({ files: [] }) };
      }
      return { ok: true, json: async () => ({ files: [] }) };
    }));

    const hydration = useFileStore.getState().hydrateUploads(SESSION);
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    releaseListing?.();
    await hydration;

    // The held listing knew nothing of the upload, so it was dropped and a
    // fresh one taken. Without the production `noteUploadsChanged` call there
    // would be exactly one.
    await vi.waitFor(() => expect(listings).toBe(2));
  });

  it("a completed delete makes an older listing refetch", async () => {
    let listings = 0;
    let releaseListing: (() => void) | undefined;
    const listingGate = new Promise<void>((r) => { releaseListing = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return { ok: true, json: async () => ({}) };
      if (url.includes("/files/uploads")) {
        listings += 1;
        if (listings === 1) await listingGate;
        return { ok: true, json: async () => ({ files: [] }) };
      }
      return { ok: true, json: async () => ({ files: [] }) };
    }));

    const hydration = useFileStore.getState().hydrateUploads(SESSION);
    await deleteUploadFromServer(SESSION, "/uploads/notes.txt");
    releaseListing?.();
    await hydration;

    await vi.waitFor(() => expect(listings).toBe(2));
  });
});
