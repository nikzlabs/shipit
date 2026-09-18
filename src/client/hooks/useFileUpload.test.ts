

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

  useSessionStore.setState({ messages: [], sessionId: SESSION });

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

    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));
    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.getUploadRefs()).toEqual([
      { path: "/uploads/notes.txt", type: "upload" },
    ]);
    expect(server.posts).toBe(2);

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

    const server = stubUploads({ failFirst: 0 });
    const { result } = renderHook(() => useFileUpload(SESSION));
    await act(async () => {
      await result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads[0]?.status).toBe("ready"));

    act(() => { result.current.retryUpload(0); });
    expect(server.posts).toBe(1);

    expect(result.current.uploads).toHaveLength(1);
  });

  it("still retries after the hook is remounted", async () => {

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

    const server = stubUploads({ failFirst: 0 });
    const first = renderHook(({ sid }) => useFileUpload(sid), {
      initialProps: { sid: undefined as string | undefined },
    });
    await act(async () => {
      await first.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    expect(server.posts).toBe(0);
    first.unmount();

    const second = renderHook(() => useFileUpload(SESSION));
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(1);
  });

  it("does NOT restart an upload whose request is still running", async () => {

    const server = gatedUploads();
    const first = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void first.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(server.posts).toBe(1));

    first.unmount();
    const second = renderHook(() => useFileUpload(SESSION));
    await act(async () => { await Promise.resolve(); });
    expect(server.posts).toBe(1);

    await act(async () => { server.release(); await Promise.resolve(); });
    await waitFor(() => expect(second.result.current.uploads[0]?.status).toBe("ready"));
    expect(server.posts).toBe(1);
  });

  it("does not re-POST a chip whose upload is already in flight", async () => {

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

    const attach = renderHook(() => useFileUpload(undefined));
    await act(async () => {
      await attach.result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    expect(posts).toBe(0);
    attach.unmount();

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

    act(() => { result.current.removeUpload(0); });
    expect(result.current.uploads).toHaveLength(0);

    await act(async () => { release?.(); await Promise.resolve(); });
    await waitFor(() => expect(deletes.some((u) => u.includes("notes.txt"))).toBe(true));

    expect(result.current.uploads).toHaveLength(0);
    expect(getSavedDraftUploads(SESSION)).not.toContain("/uploads/notes.txt");
  });
});

describe("useFileUpload — a write invalidates a listing already in flight", () => {
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

    await vi.waitFor(() => expect(listings).toBe(2));
  });

  it("a delete invalidates a listing that started while it was still open", async () => {

    let listings = 0;
    let releaseDelete: (() => void) | undefined;
    let releaseListing: (() => void) | undefined;
    const deleteGate = new Promise<void>((r) => { releaseDelete = r; });
    const listingGate = new Promise<void>((r) => { releaseListing = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        await deleteGate;
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes("/files/uploads")) {
        listings += 1;
        if (listings === 1) await listingGate;
        return { ok: true, json: async () => ({ files: [] }) };
      }
      return { ok: true, json: async () => ({ files: [] }) };
    }));

    const deletion = deleteUploadFromServer(SESSION, "/uploads/notes.txt");
    const hydration = useFileStore.getState().hydrateUploads(SESSION);
    await vi.waitFor(() => expect(listings).toBe(1));

    releaseDelete?.();
    await deletion;
    releaseListing?.();
    await hydration;

    await vi.waitFor(() => expect(listings).toBe(2));
  });

  it("a refused delete does not spend a listing's refetch budget", async () => {

    let listings = 0;
    let releaseDelete: (() => void) | undefined;
    let releaseListing: (() => void) | undefined;
    const deleteGate = new Promise<void>((r) => { releaseDelete = r; });
    const listingGate = new Promise<void>((r) => { releaseListing = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        await deleteGate;
        return { ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) };
      }
      if (url.includes("/files/uploads")) {
        listings += 1;
        if (listings === 1) await listingGate;
        return { ok: true, json: async () => ({ files: [] }) };
      }
      return { ok: true, json: async () => ({ files: [] }) };
    }));

    const deletion = deleteUploadFromServer(SESSION, "/uploads/notes.txt");
    const hydration = useFileStore.getState().hydrateUploads(SESSION);
    await vi.waitFor(() => expect(listings).toBe(1));
    releaseDelete?.();
    await deletion;
    releaseListing?.();
    await hydration;

    expect(listings).toBe(1);
  });
});

describe("useFileUpload — leaving a session is not removing an attachment", () => {
  it("keeps the file and records it as a draft when the upload lands after a switch", async () => {

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

    act(() => {
      useFileStore.getState().reset();
      useSessionStore.setState({ sessionId: "session-2" });
    });

    await act(async () => { release?.(); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    expect(deletes).toEqual([]);
    expect(getSavedDraftUploads(SESSION)).toContain("/uploads/notes.txt");
  });
});

describe("useFileUpload — why a chip is missing (docs/294 req 7)", () => {

  function heldUpload() {
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
    return { deletes, release: () => release?.() };
  }

  function switchTo(sessionId: string) {
    useFileStore.getState().reset();
    useSessionStore.setState({ sessionId });
  }

  it("keeps the file when the user leaves and COMES BACK before it lands", async () => {

    const server = heldUpload();
    const { result } = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads).toHaveLength(1));

    act(() => { switchTo("session-2"); });
    act(() => { switchTo(SESSION); });

    await act(async () => { server.release(); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    expect(server.deletes).toEqual([]);
    expect(getSavedDraftUploads(SESSION)).toContain("/uploads/notes.txt");
  });

  it("still deletes the file when the user REMOVED it and then left", async () => {

    const server = heldUpload();
    const { result } = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads).toHaveLength(1));

    act(() => { result.current.removeUpload(0); });
    act(() => { switchTo("session-2"); });

    await act(async () => { server.release(); await Promise.resolve(); });
    await vi.waitFor(() => expect(server.deletes.some((u) => u.includes("notes.txt"))).toBe(true));

    expect(getSavedDraftUploads(SESSION)).not.toContain("/uploads/notes.txt");
  });
});

describe("useFileUpload — a listing taken across an open upload (docs/294 req 1)", () => {
  it("does not leave two rows for one file", async () => {
    // The counter cannot see this overlap: an UNRESOLVED mutation has not

    let listings = 0;
    let releasePost: (() => void) | undefined;
    const postGate = new Promise<void>((r) => { releasePost = r; });
    const saved = { name: "notes.txt", path: "/uploads/notes.txt", size: 4, type: "upload" as const };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        await postGate;
        return { ok: true, json: async () => ({ files: [saved] }) };
      }
      if (url.includes("/files/uploads")) {
        listings += 1;

        return { ok: true, json: async () => ({ files: [saved] }) };
      }
      return { ok: true, json: async () => ({ files: [] }) };
    }));

    const { result } = renderHook(() => useFileUpload(SESSION));
    act(() => {
      void result.current.uploadFiles([new File(["hi!!"], "notes.txt", { type: "text/plain" })]);
    });
    await waitFor(() => expect(result.current.uploads).toHaveLength(1));

    await useFileStore.getState().hydrateUploads(SESSION);

    await act(async () => { releasePost?.(); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 20));

    const rows = useFileStore.getState().sessionUploads.filter((u) => u.path === saved.path);
    expect(rows).toHaveLength(1);

    expect(listings).toBeGreaterThan(1);
  });
});
