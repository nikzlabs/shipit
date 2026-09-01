import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useMessageScroll } from "./useMessageScroll.js";
import type { ChatMessage } from "../types.js";
import type { SearchMatch } from "../../../hooks/useSearch.js";

// Manual rAF pump: callbacks queue up and we flush them one frame at a time so a
// test can mutate the container's scrollHeight between frames — simulating a tall
// message whose real height only paints over several layout cycles (the
// content-visibility:auto placeholder-then-grow behavior this hook compensates for).
let rafQueue: FrameRequestCallback[] = [];

function flushFrame(): void {
  const callbacks = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of callbacks) cb(0);
  });
}

// jsdom has no ResizeObserver and no layout, so the observations the hook relies
// on are driven by hand: `growContent()` plays the part of the browser reporting
// that the transcript got taller.
let observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
let observedTargets: Element[] = [];

// The hook reads `performance.now()` to time the post-gesture grace window, so
// the clock is ours to advance rather than something to wait out.
let clock = 0;

// Only an observer actually watching the content element hears about it growing —
// so a hook that watched only the scroll container gets no callback here, and the
// tests below fail rather than passing on a notification it would never receive.
function growContent(): void {
  const content = document.querySelector('[data-testid="content"]');
  act(() => {
    for (const o of observers) {
      if (content && o.targets.includes(content)) o.cb([], {} as ResizeObserver);
    }
  });
}

// The mobile address bar collapsing mid-scroll resizes the SCROLL CONTAINER, not
// the content — a resize the hook cannot tell apart from the transcript growing.
function resizeContainer(): void {
  const scroller = document.querySelector('[data-testid="scroller"]');
  act(() => {
    for (const o of observers) {
      if (scroller && o.targets.includes(scroller)) o.cb([], {} as ResizeObserver);
    }
  });
}

function user(text: string): ChatMessage {
  return { role: "user", text };
}

function Harness({ messages }: { messages: ChatMessage[] }) {
  const { containerRef, contentRef } = useMessageScroll(messages, false, undefined);
  return (
    <div ref={containerRef} data-testid="scroller">
      <div ref={contentRef} data-testid="content" />
    </div>
  );
}

/**
 * Same shape, but with a search match wired to a real element — the surface
 * planning#491 changed. `content-visibility: auto` is on GROUPS of 20 rows now,
 * so the group holding a match may have had only an ESTIMATED height until the
 * jump revealed it, and the real height lands in the same frame.
 */
function MatchHarness({ match }: { match: SearchMatch | undefined }) {
  const { containerRef, contentRef, currentMatchRef } = useMessageScroll([], false, match);
  return (
    <div ref={containerRef} data-testid="scroller">
      <div ref={contentRef} data-testid="content">
        <span ref={currentMatchRef} data-testid="match" />
      </div>
    </div>
  );
}

beforeEach(() => {
  rafQueue = [];
  observers = [];
  observedTargets = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.push(target);
        observedTargets.push(target);
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.targets.length = 0;
      }
    },
  );
  // Pin time so the settle loop terminates on height-stability, not the safety cap.
  // Tests that need the gesture grace window to expire advance `clock` by hand.
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMessageScroll", () => {
  it("keeps re-pinning to the bottom while a tall message grows past the old frame budget", () => {
    let height = 100;
    let scrollTop = 0;

    const view = render(<Harness messages={[]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // User sends a long message — an explicit send anchors the conversation.
    act(() => {
      view.rerender(<Harness messages={[user("a very long message")]} />);
    });

    // Drive height growth across more than the old fixed 3-frame / 100ms budget.
    const sequence = [100, 300, 600, 900, 1200, 1200, 1200, 1200, 1200, 1200];
    for (const h of sequence) {
      height = h;
      flushFrame();
    }

    // Settled at the true bottom (scrollTop === final scrollHeight), not partway.
    expect(scrollTop).toBe(1200);
    // And the loop terminates once height is stable — no runaway scheduling.
    expect(rafQueue.length).toBe(0);
  });

  it("watches the element holding the messages, not only the scroll container", () => {
    const view = render(<Harness messages={[]} />);
    // The scroll container's own box never changes when the transcript grows, so
    // watching it alone cannot see a message paint its real height.
    expect(observedTargets).toContain(view.getByTestId("content"));
  });

  it("re-pins when the transcript grows after the settle loop has given up", () => {
    // The loop stops once the height holds steady for a few frames — which an
    // 80px `content-visibility` placeholder does before it paints, and which any
    // card that expands asynchronously does long after. The height is stable
    // here throughout the loop, so the growth lands with nothing else watching.
    let height = 300;
    let scrollTop = 0;

    const view = render(<Harness messages={[]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    act(() => {
      view.rerender(<Harness messages={[user("a very long message")]} />);
    });
    for (let i = 0; i < 6; i++) flushFrame();
    expect(rafQueue.length).toBe(0); // the loop has given up
    expect(scrollTop).toBe(300); // stranded at the placeholder's bottom

    height = 2000;
    growContent();

    expect(scrollTop).toBe(2000);
  });

  it("does not mistake the position its own re-pin corrected for the user scrolling away", () => {
    // The observation lands in the same rendering update as the growth, so the
    // scroll event that growth produces is delivered afterwards and reports the
    // corrected position. Verified in a real browser: without the correction the
    // event reports a position ~700px above the new bottom, and reading that as
    // a user scroll is what stranded the view.
    let height = 300;
    let scrollTop = 0;

    const view = render(<Harness messages={[]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    act(() => {
      view.rerender(<Harness messages={[user("a very long message")]} />);
    });
    for (let i = 0; i < 6; i++) flushFrame();

    height = 2000;
    growContent();
    act(() => {
      div.dispatchEvent(new Event("scroll"));
    });

    // Auto-follow survived, so the next message still pins.
    act(() => {
      height = 2500;
      view.rerender(<Harness messages={[user("a very long message"), { role: "assistant", text: "reply" }]} />);
    });

    expect(scrollTop).toBe(2500);
  });

  it("leaves growing content alone while the user is selecting text in the transcript", () => {
    let height = 2000;
    let scrollTop = 2000;

    const view = render(<Harness messages={[{ role: "assistant", text: "hi" }]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // Mid-drag inside a message. Scrolling now would move the content out from
    // under the pointer and wreck the selection — which is why the streaming
    // re-pin already stands down here, and why the observer must too.
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: view.getByTestId("content"),
    } as unknown as Selection);

    height = 2600; // the streaming message wraps onto another line
    growContent();

    expect(scrollTop).toBe(2000);
  });

  it("leaves growing content alone once the user has scrolled away", () => {
    let height = 2000;
    let scrollTop = 0;

    const view = render(<Harness messages={[{ role: "assistant", text: "hi" }]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    act(() => {
      div.dispatchEvent(new Event("scroll")); // scrolled to the top, far from the bottom
    });

    height = 2600; // a card further down expands
    growContent();

    expect(scrollTop).toBe(0);
  });

  it("stops the in-flight settle loop the instant the user wheels — even within the near-bottom band", () => {
    const height = 2000;
    // Park the user just inside the near-bottom threshold so isNearBottom stays
    // true: only the explicit wheel gesture (not the threshold) must stop us.
    let scrollTop = height - 500 - 20; // 1480; gap of 20px < BOTTOM_THRESHOLD_PX

    const view = render(<Harness messages={[]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    act(() => {
      view.rerender(<Harness messages={[user("a long message")]} />);
    });
    // The layout effect pinned us to the bottom; re-park within the band so the
    // wheel gesture is the only thing that can stop the loop.
    scrollTop = 1480;

    act(() => {
      div.dispatchEvent(new Event("wheel"));
    });

    // Subsequent frames must NOT yank us back to the bottom.
    flushFrame();
    flushFrame();
    expect(scrollTop).toBe(1480);
    expect(rafQueue.length).toBe(0);
  });

  // A slow drag is the case the near-bottom threshold cannot cover: the thumb
  // stays inside the 40px band for many frames, so `autoScrollRef` never flips
  // and every auto-scroll path keeps firing underneath the gesture. A fast flick
  // leaves the band within one frame, which is exactly why only the slow scroll
  // got dragged back — the bug was invisible unless you scrolled gently.
  describe("a gesture in progress outranks auto-follow", () => {
    function mountAtBottom(): { view: ReturnType<typeof render>; div: HTMLElement; state: { height: number; scrollTop: number } } {
      const state = { height: 2000, scrollTop: 1500 }; // 2000 - 500 clientHeight: at the bottom
      const view = render(<Harness messages={[{ role: "assistant", text: "hi" }]} />);
      const div = view.getByTestId("scroller");
      Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => state.height });
      Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
      Object.defineProperty(div, "scrollTop", {
        configurable: true,
        get: () => state.scrollTop,
        set: (v: number) => {
          state.scrollTop = v;
        },
      });
      return { view, div, state };
    }

    it("leaves a slow drag alone while it is still inside the near-bottom band", () => {
      const { view, div, state } = mountAtBottom();

      // A thumb walks the transcript up by 15px — less than BOTTOM_THRESHOLD_PX,
      // so `isNearBottom` is still true and auto-follow is still armed.
      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1485;
        div.dispatchEvent(new Event("scroll"));
      });

      // Streaming continues underneath the finger. None of it may move the view.
      act(() => {
        state.height = 2400;
        view.rerender(<Harness messages={[{ role: "assistant", text: "hi, more tokens" }]} />);
      });
      flushFrame();
      growContent();
      expect(state.scrollTop).toBe(1485);

      // Nor may the address bar collapsing, which resizes the container mid-scroll.
      resizeContainer();
      expect(state.scrollTop).toBe(1485);
    });

    it("keeps standing down after the finger lifts, while momentum still carries the scroll", () => {
      const { div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1485;
        div.dispatchEvent(new Event("scroll"));
        div.dispatchEvent(new Event("touchend"));
      });

      // The gesture is over but the scroll is not: writing scrollTop here would
      // kill the momentum dead.
      state.height = 2400;
      growContent();
      expect(state.scrollTop).toBe(1485);
    });

    it("resumes auto-follow once the gesture and its momentum are over", () => {
      const { div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1485;
        div.dispatchEvent(new Event("scroll"));
        div.dispatchEvent(new Event("touchend"));
      });

      clock = 500; // past GESTURE_GRACE_MS
      state.height = 2400;
      growContent();

      // Still within the near-bottom band, so following the conversation is what
      // the user asked for — the gesture only ever suspended it.
      expect(state.scrollTop).toBe(2400);
    });

    it("stands down for a trackpad scroll too, which reports `wheel` and never `touchmove`", () => {
      // The wheel path has no drag flag to set — `wheel` has no end event, so a
      // sticky flag would never clear — and rides the timestamp grace alone.
      const { view, div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("wheel"));
        state.scrollTop = 1485; // still inside the near-bottom band
        div.dispatchEvent(new Event("scroll"));
      });

      act(() => {
        state.height = 2400;
        view.rerender(<Harness messages={[{ role: "assistant", text: "hi, more tokens" }]} />);
      });
      flushFrame();
      growContent();

      expect(state.scrollTop).toBe(1485);
    });

    it("hands a cancelled touch over to the grace window, not straight back to auto-follow", () => {
      // `touchcancel` fires when the system takes the gesture away mid-drag — a
      // notification, a system edge swipe. The scroll it started is still moving.
      const { div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1485;
        div.dispatchEvent(new Event("scroll"));
        div.dispatchEvent(new Event("touchcancel"));
      });

      state.height = 2400;
      growContent();
      expect(state.scrollTop).toBe(1485);
    });

    it("terminates a settle loop that was already running when the gesture began", () => {
      // The other ordering: the gesture starts BEFORE the loop in the tests above.
      // Here the loop is mid-flight, so only `shouldContinue` can stop it.
      let height = 100;
      let scrollTop = 0;

      const view = render(<Harness messages={[]} />);
      const div = view.getByTestId("scroller");
      Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
      Object.defineProperty(div, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => {
          scrollTop = v;
        },
      });

      act(() => {
        view.rerender(<Harness messages={[user("a very long message")]} />);
      });
      height = 600;
      flushFrame(); // loop is running and still correcting a growing message

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
      });
      scrollTop = 550; // where the finger put us

      height = 900;
      flushFrame();
      flushFrame();

      expect(scrollTop).toBe(550);
      expect(rafQueue.length).toBe(0);
    });

    it("still anchors on a sent message, which is newer intent than the drag", () => {
      const { view, div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1200; // dragged well clear of the bottom
        div.dispatchEvent(new Event("scroll"));
      });

      act(() => {
        state.height = 2400;
        view.rerender(<Harness messages={[{ role: "assistant", text: "hi" }, user("next question")]} />);
      });

      expect(state.scrollTop).toBe(2400);
    });
  });

  it("does not re-pin a message the user has scrolled away from when no new user message arrives", () => {
    let height = 2000;
    let scrollTop = 0; // user scrolled to the top, far from the bottom

    const view = render(<Harness messages={[{ role: "assistant", text: "hi" }]} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // Simulate the user scrolling up: dispatch a scroll event so the hook records
    // that we are no longer near the bottom.
    act(() => {
      div.dispatchEvent(new Event("scroll"));
    });

    // A streaming assistant update (not a new user message) should NOT yank the
    // view back to the bottom.
    act(() => {
      height = 2500;
      view.rerender(<Harness messages={[{ role: "assistant", text: "hi there, more tokens" }]} />);
    });
    flushFrame();

    expect(scrollTop).toBe(0);
  });
});

describe("useMessageScroll — search jump settles (planning#491)", () => {
  function setup(): { calls: { block?: string; behavior?: string }[]; setHeight: (h: number) => void; view: ReturnType<typeof render> } {
    const calls: { block?: string; behavior?: string }[] = [];
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      calls.push(typeof arg === "object" && arg !== null ? arg : {});
    };
    let height = 1000;
    const view = render(<MatchHarness match={undefined} />);
    const div = view.getByTestId("scroller");
    Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(div, "clientHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(div, "scrollTop", { configurable: true, get: () => 0, set: () => {} });
    return { calls, setHeight: (h: number) => { height = h; }, view };
  }

  it("re-centres the match while the transcript's height is still changing", () => {
    const { calls, setHeight, view } = setup();

    act(() => { view.rerender(<MatchHarness match={{ messageIndex: 3, start: 0, length: 4 }} />); });
    // The first jump is the smooth one the user sees.
    expect(calls).toHaveLength(1);
    expect(calls[0].behavior).toBe("smooth");

    // The group holding the match resolves from its estimate to its real height
    // over the next few frames. Each change must re-centre, or the match ends up
    // wherever the estimate happened to put it.
    for (const h of [4000, 7000, 7000, 7000, 7000]) {
      setHeight(h);
      flushFrame();
    }

    expect(calls.length).toBeGreaterThan(1);
    // Instant, not smooth: a second smooth scroll would restart the easing and
    // the match would drift for as long as groups keep resolving.
    expect(calls.slice(1).every((c) => c.behavior === undefined)).toBe(true);
    expect(calls.every((c) => c.block === "center")).toBe(true);
  });

  it("stops once the height has held still, rather than scrolling forever", () => {
    const { calls, setHeight, view } = setup();
    act(() => { view.rerender(<MatchHarness match={{ messageIndex: 3, start: 0, length: 4 }} />); });

    setHeight(4000);
    for (let i = 0; i < 10; i++) flushFrame();
    const settled = calls.length;

    for (let i = 0; i < 10; i++) flushFrame();
    expect(calls.length).toBe(settled);
  });

  it("stands down the moment the user takes hold of the scroll", () => {
    // The whole point of re-centring is to land ON the match. Fighting a user
    // who has started scrolling away from it would be the same bug the
    // bottom-pin path already has `userIsDriving` for.
    const { calls, setHeight, view } = setup();
    act(() => { view.rerender(<MatchHarness match={{ messageIndex: 3, start: 0, length: 4 }} />); });
    const afterJump = calls.length;

    act(() => {
      view.getByTestId("scroller").dispatchEvent(new Event("wheel", { bubbles: true }));
    });
    setHeight(9000);
    for (let i = 0; i < 5; i++) flushFrame();

    expect(calls.length).toBe(afterJump);
  });
});
