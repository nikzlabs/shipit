import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useForegroundSignal } from "./useForegroundSignal.js";

let pageHidden = false;
/**
 * What `document.hasFocus()` reports at `blur` time — the read that separates
 * "an iframe inside this page took focus" (true) from "the browser window lost
 * system focus" (false). Verified against a real browser: an iframe click fires
 * the parent's blur with `hasFocus=true`, `activeElement=IFRAME`.
 */
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

/** The preview iframe taking focus: the window keeps system focus. */
function blurToIframe(): void {
  windowKeptSystemFocus = true;
  fire(window, "blur");
}

/** The browser window itself losing focus to another OS window. */
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

  // The whole point of the hook. Window `focus` also fires when focus returns
  // from an iframe to the top-level document — which the preview iframe does on
  // every load — so on its own it is not evidence the page was ever away.
  it("ignores focus returning from an iframe", () => {
    const { onForeground } = setup({ live: true });
    for (let i = 0; i < 5; i++) {
      blurToIframe();
      fire(window, "focus");
      settle();
    }
    expect(onForeground).not.toHaveBeenCalled();
  });

  // The desktop path this listener uniquely covers: the user works in another
  // application with the browser window still VISIBLE (so no visibilitychange),
  // the machine sleeps or the network moves under a half-open socket, and the
  // return surfaces as `focus` alone over a socket that still reads OPEN.
  // Losing this would trade a cosmetic flicker for a silently dead connection.
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

  // A blur classifies exactly one focus. A second focus with no new blur behind
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
  // is classified and dropped BEFORE the connection state is consulted, so a
  // reloading preview cannot turn the backoff ladder into one retry per second
  // during an outage.
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

  // The coalesce window collapses ONE reactivation's several events. A page
  // that goes away again inside that second is a new reactivation and gets its
  // own reconnect — otherwise it is swallowed, nothing reconnects at all, and
  // the pending marker is left to be spent by an unrelated focus much later.
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
