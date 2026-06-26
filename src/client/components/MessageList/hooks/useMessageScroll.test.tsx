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

function Harness({ messages }: { messages: ChatMessage[] }) {
  const { containerRef } = useMessageScroll(messages, false, undefined);
  return <div ref={containerRef} data-testid="scroller" />;
}

beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  // Pin time so the settle loop terminates on height-stability, not the safety cap.
  vi.spyOn(performance, "now").mockReturnValue(0);
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
