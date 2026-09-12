import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useMessageScroll } from "./useMessageScroll.js";
import type { ChatMessage } from "../types.js";
import type { SearchMatch } from "../../../hooks/useSearch.js";

let rafQueue: FrameRequestCallback[] = [];

function flushFrame(): void {
  const callbacks = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of callbacks) cb(0);
  });
}

let observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
let observedTargets: Element[] = [];

let clock = 0;

// tests below fail rather than passing on a notification it would never receive.
function growContent(): void {
  const content = document.querySelector('[data-testid="content"]');
  act(() => {
    for (const o of observers) {
      if (content && o.targets.includes(content)) o.cb([], {} as ResizeObserver);
    }
  });
}

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

    act(() => {
      view.rerender(<Harness messages={[user("a very long message")]} />);
    });

    const sequence = [100, 300, 600, 900, 1200, 1200, 1200, 1200, 1200, 1200];
    for (const h of sequence) {
      height = h;
      flushFrame();
    }

    expect(scrollTop).toBe(1200);

    expect(rafQueue.length).toBe(0);
  });

  it("watches the element holding the messages, not only the scroll container", () => {
    const view = render(<Harness messages={[]} />);
    // The scroll container's own box never changes when the transcript grows, so
    // watching it alone cannot see a message paint its real height.
    expect(observedTargets).toContain(view.getByTestId("content"));
  });

  it("re-pins when the transcript grows after the settle loop has given up", () => {

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
    expect(rafQueue.length).toBe(0);                         
    expect(scrollTop).toBe(300);                                        

    height = 2000;
    growContent();

    expect(scrollTop).toBe(2000);
  });

  it("does not mistake the position its own re-pin corrected for the user scrolling away", () => {

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

    // re-pin already stands down here, and why the observer must too.
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      anchorNode: view.getByTestId("content"),
    } as unknown as Selection);

    height = 2600;                                                 
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
      div.dispatchEvent(new Event("scroll"));                                            
    });

    height = 2600;                               
    growContent();

    expect(scrollTop).toBe(0);
  });

  it("stops the in-flight settle loop the instant the user wheels — even within the near-bottom band", () => {
    const height = 2000;

    // true: only the explicit wheel gesture (not the threshold) must stop us.
    let scrollTop = height - 500 - 20;                                           

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

  describe("a gesture in progress outranks auto-follow", () => {
    function mountAtBottom(): { view: ReturnType<typeof render>; div: HTMLElement; state: { height: number; scrollTop: number } } {
      const state = { height: 2000, scrollTop: 1500 };                                          
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

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
        state.scrollTop = 1485;
        div.dispatchEvent(new Event("scroll"));
      });

      act(() => {
        state.height = 2400;
        view.rerender(<Harness messages={[{ role: "assistant", text: "hi, more tokens" }]} />);
      });
      flushFrame();
      growContent();
      expect(state.scrollTop).toBe(1485);

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

      clock = 500;                         
      state.height = 2400;
      growContent();

      expect(state.scrollTop).toBe(2400);
    });

    it("stands down for a trackpad scroll too, which reports `wheel` and never `touchmove`", () => {

      // sticky flag would never clear — and rides the timestamp grace alone.
      const { view, div, state } = mountAtBottom();

      act(() => {
        div.dispatchEvent(new Event("wheel"));
        state.scrollTop = 1485;                                     
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
      flushFrame();                                                          

      act(() => {
        div.dispatchEvent(new Event("touchmove"));
      });
      scrollTop = 550;                           

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
        state.scrollTop = 1200;                                    
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
      div.dispatchEvent(new Event("scroll"));
    });

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

    expect(calls).toHaveLength(1);
    expect(calls[0].behavior).toBe("smooth");

    // over the next few frames. Each change must re-centre, or the match ends up

    for (const h of [4000, 7000, 7000, 7000, 7000]) {
      setHeight(h);
      flushFrame();
    }

    expect(calls.length).toBeGreaterThan(1);

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
