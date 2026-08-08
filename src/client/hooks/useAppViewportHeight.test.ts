import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useAppViewportHeight } from "./useAppViewportHeight.js";

function setInnerHeight(px: number): void {
  Object.defineProperty(window, "innerHeight", { value: px, configurable: true, writable: true });
}

function appHeight(): string {
  return document.documentElement.style.getPropertyValue("--app-height");
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
  document.body.innerHTML = "";
});

describe("useAppViewportHeight", () => {
  it("measures the viewport on mount", () => {
    renderHook(() => useAppViewportHeight());

    expect(appHeight()).toBe("800px");
  });

  it("re-measures when the app is resumed", () => {
    // The bug this exists for: an installed PWA returns from an externally
    // opened window with the pre-hand-off height still applied, so the mobile
    // tab bar sits below the fold with `overflow: hidden` and no way back.
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

  it("keeps the last good value when the browser reports a zero height mid-resume", () => {
    renderHook(() => useAppViewportHeight());
    setInnerHeight(0);

    act(() => { window.dispatchEvent(new Event("pageshow")); });

    // 0 would collapse the whole shell — worse than the stale value it replaces.
    expect(appHeight()).toBe("800px");
  });

  it("returns a parked document to the top on resume", () => {
    // iOS scrolls the document to reveal a focused input even under
    // `overflow: hidden`; a resume can leave it parked there with the tab bar
    // pushed out of view and no scrollbar to bring it back.
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });

    renderHook(() => useAppViewportHeight());

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("leaves the scroll offset alone while an editable element has focus", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, "scrollY", { value: 120, configurable: true, writable: true });

    renderHook(() => useAppViewportHeight());

    // That offset is the soft keyboard doing its job — undoing it would scroll
    // the caret back under the keyboard mid-typing.
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
