import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
  useSessionNetworkMode,
  notifySessionNetworkModeChanged,
  _resetSessionNetworkModeClock,
} from "./useSessionNetworkMode.js";
import type { EgressSessionSettings } from "../../server/shared/types.js";

/**
 * docs/285 — the Send barrier's contract: it may only open on a value the SERVER
 * accepted, and a response may only land on the session it was asked about.
 */

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
    // The revision clock orders writes by ARRIVAL; the barrier has to release on
    // INTENT. Two rapid picks whose responses come back out of order — easy now
    // that a write waits for a container rebuild — would otherwise let the one
    // that answered first open the barrier while the other is still tearing a
    // container down and building its replacement. Send would go out mid-rebuild.
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

    // The SECOND write answers first — its rebuild happened to be a no-op.
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
    // one settles before the second is issued, its own revert has already put
    // the control back to Inherit and the wrong fallback looks right. So both
    // PUTs are held open, both picks are made, and only then do they fail.
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

    // Both fail. Reverting to the DISPLAYED value would restore the first pick's
    // guess — leaving the control on Contained while the server holds Inherit,
    // with the barrier open. On an Open workspace the first turn then runs Open
    // under a Contained promise.
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
    // succeeds, a newer one fails. Reverting to a value captured when the newer
    // write was issued rewinds past the accepted change — showing Inherit (read
    // as "currently Contained") while the server holds Open, with Send released
    // and the first turn about to run Open.
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

    // PUT 1 succeeds — the server is now explicitly Open.
    await act(async () => {
      serverOverride = false;
      puts[0]?.resolve({
        ok: true,
        status: 200,
        json: async () => settings({ override: false }),
      } as Response);
      await Promise.resolve();
    });
    // PUT 2 fails.
    await act(async () => {
      puts[1]?.resolve({ ok: false, status: 500 } as Response);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.saving).toBe(false));
    // The truth is Open, and that is what the control must show.
    expect(result.current.mode).toBe("open");
  });

  it("drops a response for a session it has navigated away from", async () => {
    // Revisions are keyed per session, so an in-flight response for A still
    // satisfies A's revision long after the hook moved to B — and would paint
    // A's value onto B's control.
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
    let releasePut: ((v: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Promise<Response>((r) => { releasePut = r; });
      }
      return { ok: true, status: 200, json: async () => settings() } as Response;
    }));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => { result.current.setMode("contained"); });
    // The whole point: a first turn dispatched here would resolve the OLD value
    // server-side, find no mismatch, and run under the wrong policy.
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
});

describe("useSessionNetworkMode — the barrier only opens on a known value (docs/285)", () => {
  beforeEach(() => {
    _resetSessionNetworkModeClock();
    vi.restoreAllMocks();
  });

  it("stays barred when the recovery read ALSO fails", async () => {
    // The failure path re-reads instead of guessing. If that read fails too, the
    // value on screen is still the optimistic one the server never accepted —
    // so clearing the barrier here would enable Send on a policy nobody can
    // name. Staying barred is recoverable; the turn is not.
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
    // Neither the write nor the recovery read reached the server.
    expect(result.current.saving).toBe(true);
  });

  it("lets a later read win over an earlier one that returns after it", async () => {
    // Two GETs at the same write revision — the mount hydration and a refetch
    // driven by another tab's change — both pass the write clock's check, so
    // without a read counter whichever LANDS last wins regardless of which was
    // ASKED last, and the stale one wins permanently.
    const gets: ((v: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((r) => { gets.push(r); })));

    const { result } = renderHook(() => useSessionNetworkMode("s1"));
    await waitFor(() => expect(gets).toHaveLength(1));

    // A second read is issued (as the cross-tab invalidation does).
    act(() => { notifySessionNetworkModeChanged("s1"); });
    await waitFor(() => expect(gets).toHaveLength(2));

    // The NEWER read answers first, then the older one arrives.
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
