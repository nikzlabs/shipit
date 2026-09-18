import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useForegroundSignal } from "./useForegroundSignal.js";

let pageHidden = false;

let windowKeptSystemFocus = true;

beforeEach(() => {
  vi.useFakeTimers();
  pageHidden = false;
  windowKeptSystemFocus = true;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => pageHidden,
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowKeptSystemFocus);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function settle(): void {
  act(() => { vi.advanceTimersByTime(1000); });
}

function fire(target: Window | Document, type: string): void {
  act(() => { target.dispatchEvent(new Event(type)); });
}

function blurToIframe(): void {
  windowKeptSystemFocus = true;
  fire(window, "blur");
}

function blurToAnotherWindow(): void {
  windowKeptSystemFocus = false;
  fire(window, "blur");
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

  it("ignores focus returning from an iframe", () => {
    const { onForeground } = setup({ live: true });
    for (let i = 0; i < 5; i++) {
      blurToIframe();
      fire(window, "focus");
      settle();
    }
    expect(onForeground).not.toHaveBeenCalled();
  });

  it("reconnects on focus returning from another window, even on a live connection", () => {
    const { onForeground } = setup({ live: true });
    blurToAnotherWindow();
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("classifies each focus against its own blur", () => {
    const { onForeground } = setup({ live: true });

    blurToIframe();
    fire(window, "focus");
    expect(onForeground).not.toHaveBeenCalled();

    settle();
    blurToAnotherWindow();
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);

    settle();
    blurToIframe();
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  // it is unexplained, so it must not spend the previous classification.
  it("does not reuse an external blur for a later unexplained focus", () => {
    const { onForeground } = setup({ live: true });
    blurToAnotherWindow();
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);

    settle();
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("leaves a live connection alone on a focus with no blur behind it", () => {
    const { onForeground } = setup({ live: true });
    fire(window, "focus");
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

  it("reconnects on an unexplained focus when the connection is already gone", () => {
    const { onForeground } = setup({ live: false });
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  // The escape hatch above must not become a new storm: an iframe-return focus

  // reloading preview cannot turn the backoff ladder into one retry per second

  it("does not let an iframe focus storm hammer a closed connection", () => {
    const { onForeground } = setup({ live: false });
    for (let i = 0; i < 5; i++) {
      blurToIframe();
      fire(window, "focus");
      settle();
    }
    expect(onForeground).not.toHaveBeenCalled();
  });

  it("spends a background transition once, not on every later focus", () => {
    const { onForeground } = setup({ live: true });
    fire(window, "pagehide");
    fire(window, "focus");
    expect(onForeground).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) {
      settle();
      blurToIframe();
      fire(window, "focus");
    }
    expect(onForeground).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a background transition that lands inside the coalesce window", () => {
    const { onForeground } = setup({ live: true });
    fire(window, "pageshow");
    expect(onForeground).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(200); });
    pageHidden = true;
    fire(document, "visibilitychange");

    act(() => { vi.advanceTimersByTime(300); });
    pageHidden = false;
    fire(document, "visibilitychange");
    expect(onForeground).toHaveBeenCalledTimes(2);
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
