import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useForegroundSignal } from "./useForegroundSignal.js";

let pageHidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  pageHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => pageHidden,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Renders the hook with a connection that reads live unless the test says
 * otherwise, and returns the reconnect spy.
 */
function setup(opts: { live?: boolean; enabled?: boolean } = {}) {
  const onForeground = vi.fn();
  const live = { current: opts.live ?? true };
  const view = renderHook(() =>
    useForegroundSignal({
      ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
      onForeground,
      isConnectionLive: () => live.current,
    }),
  );
  return { onForeground, live, view };
}

/** Advance past the coalesce window so the next event is judged on its merits. */
function settle(): void {
  act(() => { vi.advanceTimersByTime(1000); });
}

function fire(target: Window | Document, type: string): void {
  act(() => { target.dispatchEvent(new Event(type)); });
}

describe("useForegroundSignal", () => {
  describe("unambiguous resumes always reconnect", () => {
    it.each([
      ["visibilitychange", () => fire(document, "visibilitychange")],
      ["pageshow", () => fire(window, "pageshow")],
      ["online", () => fire(window, "online")],
    ])("%s", (_name, dispatch) => {
      const { onForeground } = setup();
      dispatch();
      expect(onForeground).toHaveBeenCalledTimes(1);
    });
  });

  // The whole point of the hook. Window `focus` also fires when focus returns
  // from an iframe to the top-level document — which the preview iframe does on
  // every load — so on its own it is not evidence the page was ever away.
  it("ignores focus on a live connection with no background transition", () => {
    const { onForeground } = setup({ live: true });
    for (let i = 0; i < 5; i++) {
      fire(window, "focus");
      settle();
    }
    expect(onForeground).not.toHaveBeenCalled();
  });

  it.each([
    ["visibilitychange while hidden", () => {
      pageHidden = true;
      fire(document, "visibilitychange");
      pageHidden = false;
    }],
    ["pagehide", () => fire(window, "pagehide")],
    ["freeze", () => fire(document, "freeze")],
  ])("reconnects on focus after %s", (_name, background) => {
    const { onForeground } = setup({ live: true });
    background();
    expect(onForeground).not.toHaveBeenCalled();

    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("reconnects on focus when the connection is already gone", () => {
    const { onForeground } = setup({ live: false });
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("spends a background transition once, not on every later focus", () => {
    const { onForeground } = setup({ live: true });
    fire(window, "pagehide");
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) {
      settle();
      fire(window, "focus");
    }
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("coalesces one reactivation's burst into a single reconnect", () => {
    const { onForeground } = setup({ live: false });
    fire(document, "visibilitychange");
    fire(window, "focus");
    fire(window, "pageshow");
    expect(onForeground).toHaveBeenCalledTimes(1);

    settle();
    fire(window, "pageshow");
    expect(onForeground).toHaveBeenCalledTimes(2);
  });

  it("never reconnects while the page is still hidden", () => {
    const { onForeground } = setup({ live: false });
    pageHidden = true;
    fire(document, "visibilitychange");
    fire(window, "pageshow");
    fire(window, "focus");
    fire(window, "online");
    expect(onForeground).not.toHaveBeenCalled();
  });

  it("attaches nothing when disabled", () => {
    const { onForeground } = setup({ enabled: false, live: false });
    fire(document, "visibilitychange");
    fire(window, "pageshow");
    fire(window, "focus");
    expect(onForeground).not.toHaveBeenCalled();
  });
});
