import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useMessageScroll } from "./useMessageScroll.js";
import type { ChatMessage } from "../types.js";

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

function user(text: string): ChatMessage {
  return { role: "user", text };
}

function assistant(text: string): ChatMessage {
  return { role: "assistant", text };
}

function Harness({ messages }: { messages: ChatMessage[] }) {
  const { containerRef } = useMessageScroll(messages, false, undefined);
  return <div ref={containerRef} data-testid="scroller" />;
}

const CLIENT_HEIGHT = 500;

/** Render the hook wired to a real div with controllable scroll metrics. */
function setup(initialHeight: number, initialScrollTop = 0) {
  const state = { height: initialHeight, scrollTop: initialScrollTop };
  const view = render(<Harness messages={[]} />);
  const div = view.getByTestId("scroller");
  Object.defineProperty(div, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(div, "clientHeight", { configurable: true, get: () => CLIENT_HEIGHT });
  Object.defineProperty(div, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (v: number) => {
      state.scrollTop = v;
    },
  });
  return { view, div, state };
}

function wheelUp(div: HTMLElement): void {
  act(() => {
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
  });
}

function wheelDown(div: HTMLElement): void {
  act(() => {
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: 50 }));
  });
}

function scrollTo(div: HTMLElement, state: { scrollTop: number }, top: number): void {
  act(() => {
    state.scrollTop = top;
    div.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  // Pin time so the settle loop terminates on height-stability, not the safety cap
  // (the cap is exercised explicitly in its own test).
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMessageScroll", () => {
  it("keeps re-pinning to the bottom while a tall message grows past the old frame budget", () => {
    const { view, state } = setup(100);

    act(() => {
      view.rerender(<Harness messages={[user("a very long message")]} />);
    });

    // Drive height growth across more than the old fixed 3-frame / 100ms budget.
    const sequence = [100, 300, 600, 900, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200];
    for (const h of sequence) {
      state.height = h;
      flushFrame();
    }

    // Settled at the true bottom (scrollTop === final scrollHeight), not partway.
    expect(state.scrollTop).toBe(1200);
    expect(rafQueue.length).toBe(0);
  });

  it("does not mistake the content-visibility placeholder height for a settled layout", () => {
    const { view, state } = setup(100);

    act(() => {
      view.rerender(<Harness messages={[user("a long message")]} />);
    });

    // Placeholder height holds for the first few frames, then the real content
    // paints in. A naive 'stable for N frames' loop would exit at 100; the minimum
    // settle window keeps it running until the real height arrives.
    const sequence = [100, 100, 100, 100, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200];
    for (const h of sequence) {
      state.height = h;
      flushFrame();
    }

    expect(state.scrollTop).toBe(1200);
    expect(rafQueue.length).toBe(0);
  });

  it("stops re-pinning the moment the user wheels up, and stays put while streaming continues", () => {
    const { view, div, state } = setup(2000);

    // User sends a message — anchors to the bottom and starts the settle loop.
    act(() => {
      view.rerender(<Harness messages={[user("hi")]} />);
    });
    flushFrame();
    expect(state.scrollTop).toBe(2000);

    // User wheels up and scrolls away from the bottom.
    wheelUp(div);
    scrollTo(div, state, 800);

    // Streaming assistant tokens keep arriving — they must NOT yank the user back.
    act(() => {
      view.rerender(<Harness messages={[user("hi"), assistant("streaming reply…")]} />);
    });
    flushFrame();
    flushFrame();

    expect(state.scrollTop).toBe(800);
  });

  it("keeps the pause sticky within the near-bottom band (does not re-arm on a small scroll up)", () => {
    const { view, div, state } = setup(2000);

    act(() => {
      view.rerender(<Harness messages={[user("hi")]} />);
    });
    flushFrame();

    // Wheel up but only a little — still within BOTTOM_THRESHOLD of the bottom.
    wheelUp(div);
    scrollTo(div, state, 1480); // gap = 2000 - 1480 - 500 = 20px

    // A streaming rerender within the band must still not re-pin.
    act(() => {
      view.rerender(<Harness messages={[user("hi"), assistant("more")]} />);
    });
    flushFrame();

    expect(state.scrollTop).toBe(1480);
  });

  it("resumes following once the user scrolls back to the true bottom", () => {
    const { view, div, state } = setup(2000);

    act(() => {
      view.rerender(<Harness messages={[user("hi")]} />);
    });
    flushFrame();

    wheelUp(div);
    scrollTo(div, state, 800); // paused

    // User scrolls all the way back to the bottom.
    scrollTo(div, state, 2000);

    // New streaming content should now be followed again.
    act(() => {
      state.height = 2600;
      view.rerender(<Harness messages={[user("hi"), assistant("x")]} />);
    });
    flushFrame();
    flushFrame();

    expect(state.scrollTop).toBe(2600);
  });

  it("re-anchors to the bottom when the user sends a new message after scrolling away", () => {
    const { view, div, state } = setup(2000);

    act(() => {
      view.rerender(<Harness messages={[user("a")]} />);
    });
    flushFrame();

    wheelUp(div);
    scrollTo(div, state, 500); // paused, reading scrollback

    // Sending another message is a deliberate re-anchor.
    act(() => {
      state.height = 2400;
      view.rerender(<Harness messages={[user("a"), user("b")]} />);
    });
    flushFrame();

    expect(state.scrollTop).toBe(2400);
  });

  it("does not get stuck off-follow after a no-op downward wheel at the bottom", () => {
    const { view, div, state } = setup(2000);

    act(() => {
      view.rerender(<Harness messages={[user("a")]} />);
    });
    flushFrame();
    expect(state.scrollTop).toBe(2000);

    // Downward wheel while already at the bottom: no movement, must not pause.
    wheelDown(div);
    act(() => {
      div.dispatchEvent(new Event("scroll"));
    });

    // Following should still be active.
    act(() => {
      state.height = 2500;
      view.rerender(<Harness messages={[user("a"), assistant("x")]} />);
    });
    flushFrame();

    expect(state.scrollTop).toBe(2500);
  });

  it("terminates at the safety cap if the content height never settles", () => {
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const v = t;
      t += 300; // 300ms per call → crosses the 1000ms cap within a few frames
      return v;
    });

    const { view, state } = setup(100);
    act(() => {
      view.rerender(<Harness messages={[user("x")]} />);
    });

    // Height grows forever, so stability is never reached — only the cap can stop it.
    let h = 100;
    for (let i = 0; i < 12; i++) {
      h += 100;
      state.height = h;
      flushFrame();
    }

    // The loop stopped (no pending frame) rather than running unbounded.
    expect(rafQueue.length).toBe(0);
    expect(state.scrollTop).toBeGreaterThan(100);
  });
});
