import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useTabLabelCollapse } from "./useTabLabelCollapse.js";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function makeBar(scrollWidth: number, clientWidth: number): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
  return el;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useTabLabelCollapse", () => {
  it("collapses (data-collapsed=true) when the tabs overflow the bar", () => {
    const { result } = renderHook(() => useTabLabelCollapse("sig"));
    const bar = makeBar(500, 300);

    result.current(bar);
    expect(bar.dataset.collapsed).toBe("true");
  });

  it("stays expanded (data-collapsed=false) when the tabs fit", () => {
    const { result } = renderHook(() => useTabLabelCollapse("sig"));
    const bar = makeBar(300, 300);
    result.current(bar);
    expect(bar.dataset.collapsed).toBe("false");
  });

  // long after the hook's parent mounted. A callback ref must measure on every
  // attach — a stale effect keyed on a stable signature would never re-run.
  it("measures on every (re)attach, not just the first mount", () => {
    const { result } = renderHook(() => useTabLabelCollapse("sig"));
    const bar = makeBar(500, 300);

    result.current(bar);
    result.current(null);
    bar.dataset.collapsed = "false";                                           
    result.current(bar);
    expect(bar.dataset.collapsed).toBe("true");
  });
});
