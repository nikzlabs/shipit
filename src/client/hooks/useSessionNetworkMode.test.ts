import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import {
  useSessionNetworkMode,
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
