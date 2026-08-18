import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIframeOnScreen } from "./useIframeOnScreen.js";

/** Minimal IntersectionObserver whose callback the test drives by hand. */
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this);
  }
  observe(el: Element): void { this.targets.add(el); }
  unobserve(el: Element): void { this.targets.delete(el); }
  disconnect(): void { this.targets.clear(); }
  report(el: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: el, isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  IntersectionObserverStub.instances = [];
  vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const observer = () => IntersectionObserverStub.instances[0];

describe("useIframeOnScreen", () => {
  it("treats a slot as on screen until the observer says otherwise", () => {
    const { result } = renderHook(() => useIframeOnScreen());
    const el = document.createElement("iframe");

    act(() => result.current.trackIframe("s:5173", el));

    // Observed, but nothing reported yet — the signal may only ever remove
    // visibility, so an unreported slot must not read as off screen.
    expect(observer().targets.has(el)).toBe(true);
    expect(result.current.offScreenSlots.has("s:5173")).toBe(false);
  });

  it("marks a slot off screen and back on as the element leaves and re-enters", () => {
    const { result } = renderHook(() => useIframeOnScreen());
    const el = document.createElement("iframe");
    act(() => result.current.trackIframe("s:5173", el));

    act(() => observer().report(el, false));
    expect(result.current.offScreenSlots.has("s:5173")).toBe(true);

    act(() => observer().report(el, true));
    expect(result.current.offScreenSlots.has("s:5173")).toBe(false);
  });

  it("keeps slots independent", () => {
    const { result } = renderHook(() => useIframeOnScreen());
    const a = document.createElement("iframe");
    const b = document.createElement("iframe");
    act(() => { result.current.trackIframe("s:1", a); result.current.trackIframe("s:2", b); });

    act(() => observer().report(a, false));

    expect(result.current.offScreenSlots.has("s:1")).toBe(true);
    expect(result.current.offScreenSlots.has("s:2")).toBe(false);
  });

  it("clears an off-screen key when its element goes away, so a recreated slot is not stuck hidden", () => {
    const { result } = renderHook(() => useIframeOnScreen());
    const el = document.createElement("iframe");
    act(() => result.current.trackIframe("s:5173", el));
    act(() => observer().report(el, false));
    expect(result.current.offScreenSlots.has("s:5173")).toBe(true);

    act(() => result.current.trackIframe("s:5173", null));

    expect(observer().targets.has(el)).toBe(false);
    expect(result.current.offScreenSlots.has("s:5173")).toBe(false);
  });

  it("stops listening to the element a key used to hold", () => {
    const { result } = renderHook(() => useIframeOnScreen());
    const first = document.createElement("iframe");
    const second = document.createElement("iframe");
    act(() => result.current.trackIframe("s:5173", first));
    act(() => result.current.trackIframe("s:5173", second));

    expect(observer().targets.has(first)).toBe(false);
    expect(observer().targets.has(second)).toBe(true);

    // A late report from the replaced element resolves to no slot and is dropped.
    act(() => observer().report(first, false));
    expect(result.current.offScreenSlots.has("s:5173")).toBe(false);
  });

  it("reports every slot on screen where the browser has no IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { result } = renderHook(() => useIframeOnScreen());

    act(() => result.current.trackIframe("s:5173", document.createElement("iframe")));

    expect(result.current.offScreenSlots.size).toBe(0);
  });
});
