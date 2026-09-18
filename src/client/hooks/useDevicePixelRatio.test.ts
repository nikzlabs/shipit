import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevicePixelRatio } from "./useDevicePixelRatio.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(): { queries: string[]; fire: () => void } {
  const queries: string[] = [];
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query);
    return {
      matches: true,
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
  });
  return { queries, fire: () => { for (const fn of [...listeners]) fn(); } };
}

describe("useDevicePixelRatio", () => {
  it("reads the current ratio on first render", () => {
    stubMatchMedia();
    vi.stubGlobal("devicePixelRatio", 2);

    const { result } = renderHook(() => useDevicePixelRatio());

    expect(result.current).toBe(2);
  });

  it("falls back to 1 when the browser reports nothing usable", () => {
    stubMatchMedia();
    vi.stubGlobal("devicePixelRatio", 0);

    const { result } = renderHook(() => useDevicePixelRatio());

    expect(result.current).toBe(1);
  });

  it("re-arms on a fresh query after the ratio moves", () => {
    const mm = stubMatchMedia();
    vi.stubGlobal("devicePixelRatio", 1);

    const { result } = renderHook(() => useDevicePixelRatio());
    expect(mm.queries).toEqual(["(resolution: 1dppx)"]);

    vi.stubGlobal("devicePixelRatio", 2);
    act(() => { mm.fire(); });

    expect(result.current).toBe(2);

    // longer matches, so a move back to 1× would never be noticed.
    expect(mm.queries).toEqual(["(resolution: 1dppx)", "(resolution: 2dppx)"]);
  });
});
