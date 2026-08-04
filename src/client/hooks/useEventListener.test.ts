import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useEventListener, useEventListeners } from "./useEventListener.js";

afterEach(cleanup);

/** A real EventTarget (jsdom element) we can spy on AND dispatch real events to. */
function makeTarget() {
  const el = document.createElement("div");
  const addSpy = vi.spyOn(el, "addEventListener");
  const removeSpy = vi.spyOn(el, "removeEventListener");
  return { el, addSpy, removeSpy };
}

describe("useEventListener", () => {
  it("attaches on mount and invokes the handler when the event fires", () => {
    const { el } = makeTarget();
    const handler = vi.fn();
    renderHook(() => useEventListener(el, "ping", handler));

    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes the SAME listener reference on unmount, and the listener stops firing", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEventListener(el, "ping", handler));

    // The reference handed to addEventListener…
    expect(addSpy).toHaveBeenCalledTimes(1);
    const addedListener = addSpy.mock.calls[0]![1];

    unmount();

    // …is the exact reference handed to removeEventListener (the bug the
    // deferred sketch had: removing a fresh closure removes nothing).
    expect(removeSpy).toHaveBeenCalledTimes(1);
    const removedListener = removeSpy.mock.calls[0]![1];
    expect(removedListener).toBe(addedListener);

    // Behavioral proof: after unmount the listener really is gone.
    handler.mockClear();
    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).not.toHaveBeenCalled();
  });

  it("updates the handler across renders WITHOUT rebinding the listener", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(
      ({ h }: { h: (e: Event) => void }) => useEventListener(el, "ping", h),
      { initialProps: { h: first } },
    );
    expect(addSpy).toHaveBeenCalledTimes(1);

    rerender({ h: second });

    // No rebind: still a single add, zero removes — the subscription stayed put.
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();

    // …but the LATEST handler is the one that runs.
    act(() => void el.dispatchEvent(new Event("ping")));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("rebinds (remove old + add new) when the target or type changes", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const handler = vi.fn();

    const { rerender } = renderHook(
      ({ type }: { type: string }) => useEventListener(el, type, handler),
      { initialProps: { type: "ping" } },
    );
    expect(addSpy).toHaveBeenCalledTimes(1);

    rerender({ type: "pong" });

    // Old subscription torn down with its own reference, new one attached.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy.mock.calls[0]![1]).toBe(addSpy.mock.calls[0]![1]);

    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).not.toHaveBeenCalled(); // old type detached
    act(() => void el.dispatchEvent(new Event("pong")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("honors the `once` option (fires at most once)", () => {
    const { el } = makeTarget();
    const handler = vi.fn();
    renderHook(() => useEventListener(el, "ping", handler, { once: true }));

    act(() => void el.dispatchEvent(new Event("ping")));
    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("honors an AbortSignal — aborting detaches the listener", () => {
    const { el } = makeTarget();
    const handler = vi.fn();
    const controller = new AbortController();
    renderHook(() => useEventListener(el, "ping", handler, { signal: controller.signal }));

    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).toHaveBeenCalledTimes(1);

    act(() => controller.abort());
    act(() => void el.dispatchEvent(new Event("ping")));
    expect(handler).toHaveBeenCalledTimes(1); // no further calls after abort
  });

  it("infers the event type from the target (compile-time) and fires (runtime)", () => {
    // These handlers read event-specific fields; if the overloads regressed to a
    // bare `Event`, `.key` / `.data` would be a typecheck error. So this doubles
    // as a compile-time assertion that inference still works.
    const onKey = vi.fn((e: KeyboardEvent) => e.key);
    const onMsg = vi.fn((e: MessageEvent) => e.data as unknown);
    renderHook(() => {
      useEventListener(window, "keydown", (e) => onKey(e));
      useEventListener(window, "message", (e) => onMsg(e));
    });

    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    act(() => void window.dispatchEvent(new MessageEvent("message", { data: "hi" })));
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onMsg).toHaveBeenCalledTimes(1);
  });

  it("is a clean no-op when the target is null", () => {
    const handler = vi.fn();
    // Should neither throw nor attach anything.
    const { unmount } = renderHook(() => useEventListener(null, "ping", handler));
    expect(() => unmount()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("useEventListeners", () => {
  it("binds several events across different targets and tears all down with matching refs", () => {
    const a = makeTarget();
    const b = makeTarget();
    const onA = vi.fn();
    const onB = vi.fn();

    const { unmount } = renderHook(() =>
      useEventListeners([
        { target: a.el, type: "ping", handler: onA },
        { target: b.el, type: "focusish", handler: onB },
      ]),
    );

    act(() => void a.el.dispatchEvent(new Event("ping")));
    act(() => void b.el.dispatchEvent(new Event("focusish")));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);

    const addedA = a.addSpy.mock.calls[0]![1];
    const addedB = b.addSpy.mock.calls[0]![1];

    unmount();

    expect(a.removeSpy.mock.calls[0]![1]).toBe(addedA);
    expect(b.removeSpy.mock.calls[0]![1]).toBe(addedB);

    onA.mockClear();
    onB.mockClear();
    act(() => void a.el.dispatchEvent(new Event("ping")));
    act(() => void b.el.dispatchEvent(new Event("focusish")));
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
  });

  it("rebinds when a non-capture option (once) changes", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const handler = vi.fn();

    const { rerender } = renderHook(
      ({ once }: { once: boolean }) =>
        useEventListeners([{ target: el, type: "ping", handler, options: { once } }]),
      { initialProps: { once: false } },
    );
    expect(addSpy).toHaveBeenCalledTimes(1);

    rerender({ once: true });

    // once is add-time only, so a stale binding would silently keep the old
    // value — the key now includes once, forcing a correct rebind.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it("rebinds when the target identity changes even for same-tag elements", () => {
    const a = makeTarget();
    const b = makeTarget();
    const handler = vi.fn();

    const { rerender } = renderHook(
      ({ el }: { el: HTMLDivElement }) =>
        useEventListeners([{ target: el, type: "ping", handler }]),
      { initialProps: { el: a.el } },
    );
    expect(a.addSpy).toHaveBeenCalledTimes(1);

    // Swap to a DIFFERENT element with the SAME tag name — a string label like
    // "el:DIV" would collide and skip the rebind, stranding the listener on `a`.
    rerender({ el: b.el });

    expect(a.removeSpy.mock.calls[0]![1]).toBe(a.addSpy.mock.calls[0]![1]); // old detached
    expect(b.addSpy).toHaveBeenCalledTimes(1); // new attached

    // Events now fire on `b`, not `a`.
    act(() => void a.el.dispatchEvent(new Event("ping")));
    expect(handler).not.toHaveBeenCalled();
    act(() => void b.el.dispatchEvent(new Event("ping")));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rebinds when an AbortSignal identity changes", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const handler = vi.fn();
    const c1 = new AbortController();
    const c2 = new AbortController();

    const { rerender } = renderHook(
      ({ signal }: { signal: AbortSignal }) =>
        useEventListeners([{ target: el, type: "ping", handler, options: { signal } }]),
      { initialProps: { signal: c1.signal } },
    );
    expect(addSpy).toHaveBeenCalledTimes(1);

    rerender({ signal: c2.signal });
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });

  it("swaps handlers across renders without rebinding", () => {
    const { el, addSpy, removeSpy } = makeTarget();
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(
      ({ h }: { h: (e: Event) => void }) =>
        useEventListeners([{ target: el, type: "ping", handler: h }]),
      { initialProps: { h: first } },
    );
    expect(addSpy).toHaveBeenCalledTimes(1);

    rerender({ h: second });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();

    act(() => void el.dispatchEvent(new Event("ping")));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
