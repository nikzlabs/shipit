/**
 * docs/293 req 3 — "Retry" on a failed upload re-POSTs the bytes. It used to
 * remove the chip, which with req 2 (a failed upload blocks Send) would have
 * cleared the block by discarding the attachment the block protects.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileUpload } from "./useFileUpload.js";
import { useFileStore } from "../stores/file-store.js";

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
    // The retry carried the file, not an empty body.
    expect((server.bodies[1].get("file") as File).name).toBe("notes.txt");
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
});
