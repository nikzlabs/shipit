import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useApi, ApiError } from "./useApi.js";

describe("useApi", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: unknown) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    } as Response);
  }

  it("get() calls fetch with GET method", async () => {
    mockFetch(200, { hello: "world" });
    const { result } = renderHook(() => useApi());

    const data = await result.current.get<{ hello: string }>("/api/test");

    expect(data).toEqual({ hello: "world" });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      method: "GET",
    }));
  });

  it("post() calls fetch with POST method and JSON body", async () => {
    mockFetch(200, { success: true });
    const { result } = renderHook(() => useApi());

    const data = await result.current.post<{ success: boolean }>("/api/test", { name: "foo" });

    expect(data).toEqual({ success: true });
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "foo" }),
    }));
  });

  it("patch() calls fetch with PATCH method", async () => {
    mockFetch(200, { updated: true });
    const { result } = renderHook(() => useApi());

    await result.current.patch("/api/test", { title: "new" });

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ title: "new" }),
    }));
  });

  it("del() calls fetch with DELETE method", async () => {
    mockFetch(200, { deleted: true });
    const { result } = renderHook(() => useApi());

    await result.current.del("/api/test");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("throws ApiError on non-OK response with error body", async () => {
    mockFetch(404, { error: "Not found" });
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/missing")).rejects.toThrow(ApiError);
    await expect(result.current.get("/api/missing")).rejects.toMatchObject({
      status: 404,
      message: "Not found",
    });
  });

  it("throws ApiError with statusText when body has no error field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response);
    const { result } = renderHook(() => useApi());

    await expect(result.current.get("/api/broken")).rejects.toMatchObject({
      status: 500,
      message: "Internal Server Error",
    });
  });

  it("post() sends without body when none provided", async () => {
    mockFetch(200, { ok: true });
    const { result } = renderHook(() => useApi());

    await result.current.post("/api/action");

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/action", expect.objectContaining({
      method: "POST",
      body: undefined,
    }));
  });

  it("post() omits Content-Type header when no body is provided", async () => {
    // Fastify's JSON parser rejects requests advertising
    // Content-Type: application/json with an empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY → HTTP 400). Body-less POSTs must not
    // claim to be sending JSON.
    mockFetch(200, { ok: true });
    const { result } = renderHook(() => useApi());

    await result.current.post("/api/action");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
  });

  it("post() includes Content-Type header when a body is provided", async () => {
    mockFetch(200, { ok: true });
    const { result } = renderHook(() => useApi());

    await result.current.post("/api/action", { foo: 1 });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
