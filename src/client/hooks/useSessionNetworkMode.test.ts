import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
  useSessionNetworkMode,
  notifySessionNetworkModeChanged,
  _resetSessionNetworkModeClock,
} from "./useSessionNetworkMode.js";
import type { EgressSessionSettings } from "../../server/shared/types.js";

function settings(over: Partial<EgressSessionSettings> = {}): EgressSessionSettings {
  return {
    sessionId: "s1",
    override: null,
    hosts: [],
    effectiveContained: true,
    globalEnabled: true,
    enforcementActive: true,
    enforcementStatus: "active",
    startedContained: null,
    pendingRestart: false,
    ...over,
  };
}

afterEach(cleanup);

describe("useSessionNetworkMode (docs/285)", () => {
  beforeEach(() => {
    _resetSessionNetworkModeClock();
    vi.restoreAllMocks();
  });

  it("keeps Send barred while an EARLIER write is still rebuilding", async () => {

    const puts: ((v: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((r) => { puts.push(r); });
      }
      return { ok: true, status: 200, json: async () => settings() } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => { result.current.setMode("contained"); });
    act(() => { result.current.setMode("open"); });
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(result.current.saving).toBe(true);

    await act(async () => {
      puts[1]!({
        ok: true, status: 200, json: async () => settings({ override: false }),
      } as Response);
    });
    // …and the barrier must NOT open: the first write is still rebuilding.
    expect(result.current.saving).toBe(true);

    await act(async () => {
      puts[0]!({
        ok: true, status: 200, json: async () => settings({ override: true }),
      } as Response);
    });
    await waitFor(() => expect(result.current.saving).toBe(false));
  });

  it("reverts a failed write to the SERVER's value, not the last optimistic one", async () => {
    // The two writes must OVERLAP, or this cannot fail on the bug: if the first

    const puts: ((v: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((r) => { puts.push(r); });
      }
      return { ok: true, status: 200, json: async () => settings() } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe("inherit");

    act(() => { result.current.setMode("contained"); });
    act(() => { result.current.setMode("open"); });
    expect(result.current.mode).toBe("open");
    await waitFor(() => expect(puts).toHaveLength(2));

    await act(async () => {
      puts[0]?.({ ok: false, status: 500 } as Response);
      puts[1]?.({ ok: false, status: 500 } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.mode).toBe("inherit");
  });

  it("does not release Send past a write the server DID accept", async () => {
    // The ordering a remembered fallback cannot survive: an older write

    let serverOverride: boolean | null = null;
    const puts: { resolve: (v: Response) => void; body: boolean | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse((init.body as string) ?? "{}").override as boolean | null;
        return new Promise<Response>((resolve) => { puts.push({ resolve, body }); });
      }
      return {
        ok: true,
        status: 200,
        json: async () => settings({ override: serverOverride }),
      } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => { result.current.setMode("open"); });
    act(() => { result.current.setMode("contained"); });
    await waitFor(() => expect(puts).toHaveLength(2));

    await act(async () => {
      serverOverride = false;
      puts[0]?.resolve({
        ok: true,
        status: 200,
        json: async () => settings({ override: false }),
      } as Response);
      await Promise.resolve();
    });

    await act(async () => {
      puts[1]?.resolve({ ok: false, status: 500 } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.saving).toBe(false));
    // The truth is Open, and that is what the control must show.
    expect(result.current.mode).toBe("open");
  });

  it("drops a response for a session it has navigated away from", async () => {

    let releaseA: (() => void) | null = null;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/s1")) {
        await new Promise<void>((r) => { releaseA = r; });
        return { ok: true, status: 200, json: async () => settings({ sessionId: "s1", override: false }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => settings({ sessionId: "s2", override: true }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ id }: { id: string }) => useSessionNetworkMode(id), {
      initialProps: { id: "s1" },
    });
    rerender({ id: "s2" });
    await waitFor(() => expect(result.current.mode).toBe("contained"));

    // A's slow answer arrives now. It must not overwrite B.
    await act(async () => {
      releaseA?.();
      await Promise.resolve();
    });
    expect(result.current.mode).toBe("contained");
  });

  it("bars Send while a write is in flight and releases it on success", async () => {
    // The GET reflects what the PUT persisted, because the real server does. A
    // stub whose read contradicts its own write cannot tell a correct re-read

    let stored: boolean | null = null;
    let releasePut: ((v: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        stored = (JSON.parse(init.body as string) as { override: boolean | null }).override;
        return new Promise<Response>((r) => { releasePut = r; });
      }
      return {
        ok: true, status: 200, json: async () => settings({ override: stored }),
      } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => { result.current.setMode("contained"); });

    expect(result.current.saving).toBe(true);

    await act(async () => {
      releasePut?.({
        ok: true,
        status: 200,
        json: async () => settings({ override: true }),
      } as Response);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.mode).toBe("contained");
  });

  it("converges on the SERVER's value when responses arrive out of issue order", async () => {

    let stored: boolean | null = null;
    const puts: { override: boolean | null; resolve: (v: Response) => void }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const override = (JSON.parse(init.body as string) as { override: boolean | null }).override;
        return new Promise<Response>((resolve) => { puts.push({ override, resolve }); });
      }
      return {
        ok: true, status: 200, json: async () => settings({ override: stored }),
      } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => { result.current.setMode("contained") });                 
    act(() => { result.current.setMode("open") });                       
    await waitFor(() => expect(puts).toHaveLength(2));

    stored = puts[1]!.override;
    await act(async () => {
      puts[1]!.resolve({ ok: true, status: 200, json: async () => settings({ override: stored }) } as Response);
      await Promise.resolve();
    });
    stored = puts[0]!.override;
    await act(async () => {
      puts[0]!.resolve({ ok: true, status: 200, json: async () => settings({ override: stored }) } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.saving).toBe(false));

    expect(result.current.mode).toBe("contained");
  });
});

describe("useSessionNetworkMode — the barrier only opens on a known value (docs/285)", () => {
  beforeEach(() => {
    _resetSessionNetworkModeClock();
    vi.restoreAllMocks();
  });

  it("stays barred when the recovery read ALSO fails", async () => {

    // value on screen is still the optimistic one the server never accepted —

    let allowGet = true;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return { ok: false, status: 500 } as Response;
      if (!allowGet) return { ok: false, status: 503 } as Response;
      return { ok: true, status: 200, json: async () => settings() } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    allowGet = false;
    await act(async () => {
      result.current.setMode("contained");
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.mode).toBe("contained"));

    expect(result.current.saving).toBe(true);
  });

  it("lets a later read win over an earlier one that returns after it", async () => {

    const gets: ((v: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((r) => { gets.push(r); })));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(gets).toHaveLength(1));

    act(() => { notifySessionNetworkModeChanged("s1"); });
    await waitFor(() => expect(gets).toHaveLength(2));

    await act(async () => {
      gets[1]?.({ ok: true, status: 200, json: async () => settings({ override: false }) } as Response);
      await Promise.resolve();
    });
    await act(async () => {
      gets[0]?.({ ok: true, status: 200, json: async () => settings({ override: null }) } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.mode).toBe("open");
  });
});
