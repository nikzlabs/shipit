import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useAppViewportHeight } from "./useAppViewportHeight.js";

function setInnerHeight(px: number): void {
  Object.defineProperty(window, "innerHeight", { value: px, configurable: true, writable: true });
}

function appHeight(): string {
  return document.documentElement.style.getPropertyValue("--app-height");
}

function stubVisualViewport(props: { offsetTop: number; scale: number }): void {
  Object.defineProperty(window, "visualViewport", {
    value: { ...props, height: window.innerHeight, addEventListener: () => {}, removeEventListener: () => {} },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  document.documentElement.style.removeProperty("--app-height");
  setInnerHeight(800);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  document.body.innerHTML = "";
});

describe("useAppViewportHeight", () => {
  it("measures the viewport on mount", () => {
    renderHook(() => useAppViewportHeight());

    expect(appHeight()).toBe("800px");
  });

  it("re-measures when the app is resumed", () => {

    renderHook(() => useAppViewportHeight());
    setInnerHeight(650);

    act(() => { window.dispatchEvent(new Event("pageshow")); });

    expect(appHeight()).toBe("650px");
  });

  it("re-measures on each of the resume signals, since no one of them fires everywhere", () => {
    renderHook(() => useAppViewportHeight());

    for (const [i, fire] of [
      () => { window.dispatchEvent(new Event("focus")); },
      () => { document.dispatchEvent(new Event("visibilitychange")); },
      () => { window.dispatchEvent(new Event("resize")); },
      () => { window.dispatchEvent(new Event("orientationchange")); },
    ].entries()) {
      setInnerHeight(700 + i);
      act(() => { fire(); });
      expect(appHeight()).toBe(`${700 + i}px`);
    }
  });

  it("re-measures after the window settles, not only at the instant of the event", () => {

    // pixel snapshot, unlike `dvh`, never corrects itself.
    vi.useFakeTimers();
    try {
      renderHook(() => useAppViewportHeight());

      act(() => { window.dispatchEvent(new Event("pageshow")); });
      expect(appHeight()).toBe("800px");

      setInnerHeight(650);
      act(() => { vi.advanceTimersByTime(500); });

      expect(appHeight()).toBe("650px");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last good value when the browser reports a zero height mid-resume", () => {
    renderHook(() => useAppViewportHeight());
    setInnerHeight(0);

    act(() => { window.dispatchEvent(new Event("pageshow")); });

    expect(appHeight()).toBe("800px");
  });

  it("returns a parked document to the top on resume", () => {

    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("unparks a visual viewport panned with the root scroll still at zero", () => {

    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    stubVisualViewport({ offsetTop: 90, scale: 1 });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("leaves a pinch-zoomed viewport where the user panned it", () => {

    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });
    stubVisualViewport({ offsetTop: 90, scale: 2.5 });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves the scroll offset alone while a cross-origin preview iframe has focus", () => {

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframe.focus();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves the scroll offset alone while an editable element has focus", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
