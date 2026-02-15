import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useMediaQuery, useIsMobile } from "./useMediaQuery.js";

afterEach(cleanup);

describe("useMediaQuery", () => {
  let listeners: Map<string, ((e: MediaQueryListEvent) => void)[]>;
  let matchesMap: Map<string, boolean>;

  beforeEach(() => {
    listeners = new Map();
    matchesMap = new Map();

    // Mock window.matchMedia
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => {
        if (!listeners.has(query)) listeners.set(query, []);
        return {
          matches: matchesMap.get(query) ?? false,
          media: query,
          addEventListener: (_: string, handler: (e: MediaQueryListEvent) => void) => {
            listeners.get(query)!.push(handler);
          },
          removeEventListener: (_: string, handler: (e: MediaQueryListEvent) => void) => {
            const arr = listeners.get(query)!;
            const idx = arr.indexOf(handler);
            if (idx >= 0) arr.splice(idx, 1);
          },
        };
      }),
    });
  });

  /** Simulate a media query change by calling all registered listeners. */
  function fireChange(query: string, matches: boolean) {
    matchesMap.set(query, matches);
    for (const handler of listeners.get(query) ?? []) {
      handler({ matches, media: query } as MediaQueryListEvent);
    }
  }

  it("returns false when the query does not match", () => {
    matchesMap.set("(max-width: 767px)", false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });

  it("returns true when the query matches", () => {
    matchesMap.set("(max-width: 767px)", true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query changes", () => {
    matchesMap.set("(max-width: 767px)", false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);

    act(() => fireChange("(max-width: 767px)", true));
    expect(result.current).toBe(true);

    act(() => fireChange("(max-width: 767px)", false));
    expect(result.current).toBe(false);
  });

  it("cleans up the listener on unmount", () => {
    matchesMap.set("(max-width: 767px)", false);
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(listeners.get("(max-width: 767px)")!.length).toBe(1);

    unmount();
    expect(listeners.get("(max-width: 767px)")!.length).toBe(0);
  });

  it("re-subscribes when the query string changes", () => {
    matchesMap.set("(max-width: 767px)", false);
    matchesMap.set("(max-width: 1024px)", true);

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useMediaQuery(q),
      { initialProps: { q: "(max-width: 767px)" } }
    );
    expect(result.current).toBe(false);

    rerender({ q: "(max-width: 1024px)" });
    expect(result.current).toBe(true);
  });
});

describe("useIsMobile", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it("returns true for mobile viewport query", () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });
});
