import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import type { ChatMessage } from "./types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { SessionInfo, SessionStatus } from "../../../server/shared/types.js";

/**
 * planning#595 — opening a session lands at the END of its conversation.
 *
 * The defect this guards was not in any one helper, so neither is the guard: it
 * mounts the real `MessageList`, walks the real open sequence (the outgoing
 * transcript, the loading gap in which only the status card is on screen, then
 * the incoming transcript) and asserts where the view ends up.
 *
 * ## The fake layout, and what it can fail on
 *
 * jsdom has no layout, so `scrollHeight` is modelled — but modelled FROM THE
 * RENDERED DOM (rows present x ROW_H, plus the card's height when the card is
 * rendered), never from a number the test hands over. That is the crux of the
 * bug: the card renders from the session record rather than the transcript, so
 * it is still on screen when the messages are gone, and its height is how far
 * the loading view can be scrolled.
 *
 * `scrollTop` is a real accessor that clamps to the scrollable range and, when
 * the clamp moves it, dispatches `scroll` — the browser behaviour the shipped
 * code depended on by accident for its repair. Without it every case would be
 * red and the fixture would prove nothing about WHICH ones were broken; the
 * "left far down" case below is here to hold that honest, because it passes
 * with or without the fix.
 *
 * What it cannot fail on, so that nobody reads more into a green run than it
 * says: the `ResizeObserver` correction (jsdom has none, so a stub stands in,
 * fired where the browser fires it — but on the test's timing, not Chrome's);
 * real text measurement and layout growth; an interrupted deferred render;
 * and the search-match scroll. Those were measured live in the dogfood
 * instance instead, and the numbers are in the PR.
 *
 * **What these cases distinguish has since narrowed, and this is the honest
 * statement of it.** When they were written, removing the follow flag, either
 * gesture ref or the selection clearing each turned one red. The second pass on
 * planning#595 added an "opening" state whose `ResizeObserver` branch now pins
 * through an open regardless of the follow flag and a stale gesture stamp — so
 * it covers for those removals a frame later, and only the selection clearing
 * still fails a case here on its own. The resets are kept because the open's
 * invariant rests on them: it holds only while the follow flag is true across a
 * switch, which is what the reset makes so. `session-open-settle.test.tsx` is
 * where the opening state's own parts are each held red.
 */

const VIEWPORT = 625;
const ROW_H = 80;
const CARD_H = 1336;

let observers: { cb: () => void; targets: Element[] }[] = [];

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
  class FakeResizeObserver {
    private entry: { cb: () => void; targets: Element[] };
    constructor(cb: () => void) {
      this.entry = { cb, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { observers = observers.filter((o) => o !== this.entry); }
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
});

/** What the browser reports after a render: the content it actually laid out. */
function contentHeight(container: Element): number {
  const rows = container.querySelectorAll("[data-compact-content]").length;
  const card = container.querySelector("[data-testid='session-status-card']") ? CARD_H : 0;
  return rows * ROW_H + card;
}

/**
 * Give the scroll container a layout that answers from the DOM, with a
 * `scrollTop` that clamps and reports the clamp the way a real one does.
 */
function installLayout(container: HTMLElement): void {
  let top = 0;
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollHeight: { configurable: true, get: () => Math.max(contentHeight(container), VIEWPORT) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        const max = Math.max(contentHeight(container) - VIEWPORT, 0);
        top = Math.min(Math.max(value, 0), max);
      },
    },
  });
}

/**
 * The frame after a render: the browser clamps a `scrollTop` the shrunken
 * content can no longer hold (firing `scroll`), then delivers the resize to
 * whoever is observing the element whose height moved — the content element,
 * which is the transcript's own box rather than the scroll container's.
 */
function settleFrame(container: HTMLElement): void {
  act(() => {
    const before = container.scrollTop;
    // eslint-disable-next-line no-self-assign -- the clamp is in the setter
    container.scrollTop = container.scrollTop;
    if (container.scrollTop !== before) container.dispatchEvent(new Event("scroll"));
    const content = container.lastElementChild;
    for (const o of observers) {
      if (content && o.targets.includes(content)) o.cb();
    }
  });
}

const status: SessionStatus = {
  lastTurn: "Wired the billing route.",
  status: "Investigating the open path.\n\n- one\n- two",
  needsYou: ["Paste a token."],
  actions: [],
  fresh: true,
  writeSeq: 1, turnSeq: 0,
};

function session(id: string): SessionInfo {
  return {
    id,
    title: id,
    createdAt: "2026-01-01T00:00:00Z",
    lastUsedAt: "2026-01-01T00:00:00Z",
    sessionStatus: status,
  } as SessionInfo;
}

function show(id: string): void {
  act(() => {
    useSessionStore.setState({
      sessionId: id,
      sessions: [session("s1"), session("s2")],
      activeRunnerSessions: new Set<string>(),
    });
  });
}

function transcript(prefix: string, count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `${prefix} message ${i}`,
  } as ChatMessage));
}

beforeEach(() => {
  observers = [];
  useSettingsStore.setState({ sessionStatusCard: true });
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessionId: undefined, sessions: [], activeRunnerSessions: new Set<string>() });
  useSettingsStore.setState({ sessionStatusCard: false });
});

/**
 * Open s2 after leaving s1 at `leftAt`, and answer where the view landed.
 *
 * The loading render in the middle is not decoration: it is the only moment at
 * which the card is the whole of the content, which is what makes a reader who
 * was near the top of s1 produce no clamp and so no repair.
 */
function openAfterLeaving(
  leftAt: number,
  leave?: (scroller: HTMLElement) => void,
): { top: number; fromBottom: number } {
  show("s1");
  const outgoing = transcript("s1", 40);
  const { container, rerender } = render(<MessageList messages={outgoing} isLoading={false} />);
  const scroller = container.querySelector<HTMLElement>("[data-chat-transcript]")!;
  installLayout(scroller);
  settleFrame(scroller);

  // The reader scrolls back through s1 and stops.
  act(() => {
    scroller.scrollTop = leftAt;
    scroller.dispatchEvent(new Event("scroll"));
  });
  expect(scroller.scrollTop).toBe(leftAt);
  leave?.(scroller);

  // The switch: the transcript is cleared, the incoming session's card is not.
  show("s2");
  rerender(<MessageList messages={[]} isLoading={false} />);
  // The premise, asserted rather than assumed: with no messages left, the card
  // is the whole of the content. A card that stopped rendering here would make
  // every case below pass for a reason that has nothing to do with the fix.
  expect(contentHeight(scroller)).toBe(CARD_H);
  settleFrame(scroller);

  // Its history arrives.
  rerender(<MessageList messages={transcript("s2", 60)} isLoading={false} />);
  settleFrame(scroller);

  // "At the bottom" is only worth asserting over the conversation that was
  // opened: the bottom of the loading card alone would satisfy the position
  // check while the history had not rendered at all.
  expect(scroller.querySelectorAll("[data-compact-content]").length).toBe(60);

  return {
    top: scroller.scrollTop,
    fromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
  };
}

describe("opening a session with a status card", () => {
  it("lands at the end of the conversation when the reader left the last one at the top", () => {
    expect(openAfterLeaving(0).fromBottom).toBe(0);
  });

  it("lands at the end when the reader left inside the card's own overflow", () => {
    // 300 is within CARD_H - VIEWPORT, so the loading content still holds the
    // outgoing position and the browser never clamps it: the range the card
    // widens the defect over, from the single position a card-less transcript
    // could fail at.
    expect(openAfterLeaving(300).fromBottom).toBe(0);
  });

  it("lands at the end when the reader left far down the last conversation", () => {
    // Passes without the fix too — the clamp repaired this one by accident, and
    // that is exactly why the fixture must include it.
    expect(openAfterLeaving(2000).fromBottom).toBe(0);
  });

  it("lands at the end when the reader left mid-gesture", () => {
    // A flick and then a click on another session: the gesture stamp is inside
    // its grace window when the incoming history arrives, and every pinning
    // path stands down for a live gesture — one the incoming session never had.
    expect(openAfterLeaving(300, (scroller) => {
      act(() => {
        scroller.dispatchEvent(new Event("touchmove"));
        scroller.dispatchEvent(new Event("wheel"));
      });
    }).fromBottom).toBe(0);
  });

  it("lands at the end when a selection made in the card outlives the switch", () => {
    // The card keeps its DOM across the switch, so a selection inside it is
    // still inside the container afterwards — reachable without a click in the
    // page at all, which is how the browser normally collapses one. Measured
    // with the back button in the dogfood instance.
    expect(openAfterLeaving(300, (scroller) => {
      const card = scroller.querySelector("[data-testid='session-status-card']")!;
      const range = document.createRange();
      range.selectNodeContents(card);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }).fromBottom).toBe(0);
    window.getSelection()?.removeAllRanges();
  });

  it("leaves the reader where they are inside the session they are reading", () => {
    show("s1");
    const messages = transcript("s1", 40);
    const { container, rerender } = render(<MessageList messages={messages} isLoading={false} />);
    const scroller = container.querySelector<HTMLElement>("[data-chat-transcript]")!;
    installLayout(scroller);
    settleFrame(scroller);

    act(() => {
      scroller.scrollTop = 400;
      scroller.dispatchEvent(new Event("scroll"));
    });

    rerender(<MessageList messages={[...messages, { role: "assistant", text: "s1 reply" } as ChatMessage]} isLoading={false} />);
    settleFrame(scroller);

    expect(scroller.scrollTop).toBe(400);
  });
});
