import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useVisualViewportHeight } from "./useVisualViewportHeight.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

describe("useVisualViewportHeight", () => {
  let listeners: Map<string, (() => void)[]>;
  let vv: { height: number; offsetTop: number };

  /** Install a fake VisualViewport whose resize/scroll events we can fire. */
  function installVisualViewport(initial: { height: number; offsetTop: number }) {
    listeners = new Map();
    vv = { ...initial };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        get height() {
          return vv.height;
        },
        get offsetTop() {
          return vv.offsetTop;
        },
        addEventListener: (type: string, handler: () => void) => {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type)!.push(handler);
        },
        removeEventListener: (type: string, handler: () => void) => {
          const arr = listeners.get(type) ?? [];
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        },
      },
    });
  }

  function fire(type: string, next: { height: number; offsetTop: number }) {
    vv = { ...next };
    for (const handler of listeners.get(type) ?? []) handler();
  }

  beforeEach(() => {
    installVisualViewport({ height: 800, offsetTop: 0 });
  });

  it("writes the initial viewport height and offset to CSS variables", () => {
    renderHook(() => useVisualViewportHeight());
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-vh")).toBe("800px");
    expect(root.style.getPropertyValue("--app-vv-top")).toBe("0px");
  });

  it("shrinks the height when the keyboard opens (resize)", () => {
    renderHook(() => useVisualViewportHeight());
    // Keyboard opens: visual viewport shrinks, layout scrolls under it (iOS).
    act(() => fire("resize", { height: 480, offsetTop: 0 }));
    expect(document.documentElement.style.getPropertyValue("--app-vh")).toBe("480px");
  });

  it("tracks the offset when the layout viewport scrolls under the keyboard", () => {
    renderHook(() => useVisualViewportHeight());
    act(() => fire("scroll", { height: 480, offsetTop: 120 }));
    expect(document.documentElement.style.getPropertyValue("--app-vv-top")).toBe("120px");
  });

  it("removes the CSS variables on unmount", () => {
    const { unmount } = renderHook(() => useVisualViewportHeight());
    unmount();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-vh")).toBe("");
    expect(root.style.getPropertyValue("--app-vv-top")).toBe("");
  });

  it("no-ops without VisualViewport support", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    expect(() => renderHook(() => useVisualViewportHeight())).not.toThrow();
    expect(document.documentElement.style.getPropertyValue("--app-vh")).toBe("");
  });
});
