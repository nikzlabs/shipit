import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { MessageList } from "./MessageList.js";
import type { ChatMessage } from "./types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { SessionInfo, SessionStatus } from "../../../server/shared/types.js";

/**
 * planning#595, second report — a session that opens still lands at the END once
 * its conversation has actually painted.
 *
 * `session-open-scroll.test.tsx` guards the first pin happening. This one guards
 * it LANDING, which is a different claim and the one the second report is about:
 * the pin measures a `content-visibility` estimate of a conversation that has
 * not painted, so it is thousands of pixels short at the moment the layout
 * effect finishes, and everything that closes that gap afterwards used to be
 * conditional. Measured in the dogfood instance over a 900-message transcript:
 * the pin landed at 79,714 of a real 84,075 and the corrections ran for a
 * further 760ms.
 *
 * ## The fake layout, and what it can fail on
 *
 * jsdom has no layout, so `scrollHeight` is modelled — but from the RENDERED
 * DOM, and in two stages, because the two stages ARE the defect: a row reports
 * `PLACEHOLDER_H` until the transcript is `paint()`ed and `ROW_H` afterwards,
 * exactly as a `[content-visibility:auto]` group reports its
 * `contain-intrinsic-size` until it renders. `scrollTop` clamps and fires
 * `scroll` on the clamp, as a real one does.
 *
 * Frames are pumped by hand (`frame()`): animation callbacks, then the clamp,
 * then a resize delivered to whoever observes the content element. This is a
 * MODEL and deliberately not a claim about Chrome's ordering — a real frame
 * fires pending scroll events before the animation callbacks, and a
 * programmatic `scrollTop` write queues a scroll event of its own, neither of
 * which this reproduces.
 *
 * What it cannot fail on, so nobody reads more into a green run than it says:
 * Chrome's decision about WHEN a group paints (the test picks the frame) and
 * the length of the plateau before it; deadline expiry, a backgrounded tab and
 * the settle loop's cap, since these frames run against the real clock and
 * cross no deadline deliberately; scroll anchoring;
 * `CompactLayout`'s competing `scrollTop` writes, which need row rectangles
 * jsdom does not give; real text measurement; and an interrupted deferred
 * render. Those were measured live in the dogfood instance instead, and the
 * numbers are in the PR.
 *
 * Of the fix, these cases distinguish the `ResizeObserver` pinning through the
 * open, its still standing down for a selection while it does, the hold
 * outlasting the plateau at the estimate, the scroll rule handing the view back
 * the moment the reader moves it, and hydration no longer being mistaken for an
 * appended user message. Every part is red on its own under one case or
 * another, here or in `useMessageScroll.test.tsx`; nothing is carried as
 * consistency alone.
 *
 * Two of those live at the hook's level rather than here, because the geometry
 * has to be posed directly: telling our own echoed position from the reader's,
 * and the settle loop stopping for a selection. "lands at the end when a scroll
 * is reported while the height is still the estimate" below does NOT distinguish
 * the first — at that moment the position IS the bottom of the estimate and
 * reads near either way — and is here only because the open must survive the
 * event at all.
 */

const VIEWPORT = 625;
const ROW_H = 80;
/** What a row's group reports before it has painted — `contain-intrinsic-size`. */
const PLACEHOLDER_H = 24;
const CARD_H = 1336;

let observers: { cb: () => void; targets: Element[] }[] = [];
let queued: (() => void)[] = [];
let painted = false;

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
  globalThis.requestAnimationFrame = ((cb: () => void) => { queued.push(cb); return queued.length; }) as never;
  globalThis.cancelAnimationFrame = (() => {}) as never;
});

function contentHeight(container: Element): number {
  const rows = container.querySelectorAll("[data-compact-content]").length;
  const card = container.querySelector("[data-testid='session-status-card']") ? CARD_H : 0;
  return rows * (painted ? ROW_H : PLACEHOLDER_H) + card;
}

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

let lastSeenHeight = -1;

/**
 * One browser frame: the animation callbacks, then the clamp (with its `scroll`
 * event), then the resize delivered to the content element's observers. A
 * resize is delivered only when the height actually moved, as a real
 * `ResizeObserver` does.
 */
function frame(container: HTMLElement): void {
  act(() => {
    const due = queued;
    queued = [];
    for (const cb of due) cb();

    const before = container.scrollTop;
    // eslint-disable-next-line no-self-assign -- the clamp is in the setter
    container.scrollTop = container.scrollTop;
    if (container.scrollTop !== before) container.dispatchEvent(new Event("scroll"));

    const height = container.scrollHeight;
    if (height !== lastSeenHeight) {
      lastSeenHeight = height;
      const content = container.lastElementChild;
      for (const o of observers) if (content && o.targets.includes(content)) o.cb();
    }
  });
}

function frames(container: HTMLElement, count: number): void {
  for (let i = 0; i < count; i++) frame(container);
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

/** A history whose last row is the user's — a session opened mid-turn, before its reply. */
function transcriptEndingInUser(prefix: string, count: number): ChatMessage[] {
  const rows = transcript(prefix, count);
  rows[rows.length - 1] = { role: "user", text: `${prefix} the question` } as ChatMessage;
  return rows;
}

beforeEach(() => {
  observers = [];
  queued = [];
  painted = false;
  lastSeenHeight = -1;
  useSettingsStore.setState({ sessionStatusCard: true });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  useSessionStore.setState({ sessionId: undefined, sessions: [], activeRunnerSessions: new Set<string>() });
  useSettingsStore.setState({ sessionStatusCard: false });
});

/**
 * Open s2 after leaving s1 at its end, walking the real sequence: the outgoing
 * transcript, the loading gap in which the card is the whole of the content, the
 * incoming rows at their unpainted placeholder height, and then the paint.
 *
 * `duringGap` and `beforePaint` are where the failures live — the moments at
 * which a gesture, a selection or a `scroll` read used to stand the correction
 * down for good.
 */
function openSession(hooks: {
  duringGap?: (scroller: HTMLElement) => void;
  beforePaint?: (scroller: HTMLElement) => void;
  afterPaint?: (scroller: HTMLElement) => void;
  /**
   * The rows arrive already at their laid-out height — a short conversation, or
   * one whose groups Chrome sizes on the first pass. Nothing resizes afterwards,
   * so no `ResizeObserver` fires and the layout effect's own pin is the ONLY
   * thing that can put the view at the end.
   */
  arrivesPainted?: boolean;
  /** Open a session that is mid-turn: its history ends with the user's own row. */
  endsInUser?: boolean;
} = {}): { top: number; fromBottom: number } {
  show("s1");
  const outgoing = transcript("s1", 40);
  painted = true;
  const { container, rerender } = render(<MessageList messages={outgoing} isLoading={false} />);
  const scroller = container.querySelector<HTMLElement>("[data-chat-transcript]")!;
  installLayout(scroller);
  frames(scroller, 6);
  expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBe(0);

  // The switch. The transcript is cleared; the incoming session's card is not.
  show("s2");
  rerender(<MessageList messages={[]} isLoading={false} />);
  expect(contentHeight(scroller)).toBe(CARD_H);
  frames(scroller, 6);
  hooks.duringGap?.(scroller);

  // Its history arrives, and its rows have NOT painted yet: the height the pin
  // measures is the placeholder estimate, which is the crux.
  painted = !!hooks.arrivesPainted;
  const incoming = hooks.endsInUser ? transcriptEndingInUser("s2", 60) : transcript("s2", 60);
  rerender(<MessageList messages={incoming} isLoading={false} />);
  expect(scroller.querySelectorAll("[data-compact-content]").length).toBe(60);
  frames(scroller, 2);
  hooks.beforePaint?.(scroller);
  frames(scroller, 2);

  // The groups paint and the conversation takes its real height.
  painted = true;
  frames(scroller, 8);
  hooks.afterPaint?.(scroller);
  frames(scroller, 8);

  return {
    top: scroller.scrollTop,
    fromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
  };
}

const wheel = (scroller: HTMLElement) => act(() => {
  scroller.dispatchEvent(new Event("wheel"));
});

describe("opening a session lands at the end once the conversation has painted", () => {
  it("lands at the end when the rows paint after the pin", () => {
    // The control for the shape: nothing interferes, and the pin is still
    // thousands of pixels short at the moment the layout effect finishes.
    expect(openSession().fromBottom).toBe(0);
  });

  it("lands at the end when a scroll is reported while the height is still the estimate", () => {
    // The browser reporting our own pin back. At this moment the position IS
    // the bottom of the estimate, so the read is near-bottom either way and the
    // case cannot distinguish the fix — it is here because the open must
    // survive the event at all, and the distinguishing geometry is posed
    // directly in `useMessageScroll.test.tsx`.
    expect(openSession({
      beforePaint: (scroller) => act(() => { scroller.dispatchEvent(new Event("scroll")); }),
    }).fromBottom).toBe(0);
  });

  it("lands at the end when a gesture over the card carries into the open", () => {
    // A wheel while the card is the whole of the content — the reader looking at
    // the card in the loading gap. Every pinning path stands down for a live
    // gesture, and the grace window outlives the gap, so the conversation
    // arrived under a gesture that was never about it.
    expect(openSession({ duringGap: wheel }).fromBottom).toBe(0);
  });

  it("obeys a selection made in the card while the conversation was loading", () => {
    // The switch clears a selection that crossed it, because the conversation
    // it was made in has gone. This one is made AFTER the switch, in the
    // incoming session's own card — content that, for an idle session, is still
    // on screen and is where the end of the conversation is. The reader is
    // holding it, so the open does not move it. An earlier cut cleared it here
    // and that is a reader's text destroyed to satisfy a scroll position.
    expect(openSession({
      duringGap: (scroller) => act(() => {
        const card = scroller.querySelector("[data-testid='session-status-card']")!;
        const range = document.createRange();
        range.selectNodeContents(card);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }),
    }).fromBottom).toBeGreaterThan(0);
  });

  it("leaves the card where the reader put it when they scroll it in the loading gap", () => {
    // Not the same case as the wheel above, and the difference is the whole
    // rule: that wheel moved nothing, this one moves the view, so this one is
    // the reader taking it. A tall card is taller than the viewport and reading
    // its first paragraph means scrolling up — an open must not treat that as
    // noise and throw them to the end of a conversation they did not ask to be
    // shown the end of. A gesture and the scroll it produces must also not
    // decide this differently according to which the browser delivers first,
    // which is why only the position decides.
    const result = openSession({
      duringGap: (scroller) => act(() => {
        scroller.dispatchEvent(new Event("wheel"));
        scroller.scrollTop = 300;
        scroller.dispatchEvent(new Event("scroll"));
      }),
    });
    expect(result.top).toBe(300);
  });

  it("keeps the reader's gap scroll when the arriving history ends with their own row", () => {
    // A session opened mid-turn, before its first reply. Hydration is not an
    // append: counting it as one makes the strongest exception in the hook fire
    // — the appended-user-message path, which overrides the follow flag AND
    // clears gesture state — so the reader who had scrolled the loading card
    // was thrown to the end by a message they sent before they ever opened it.
    const result = openSession({
      endsInUser: true,
      duringGap: (scroller) => act(() => {
        scroller.dispatchEvent(new Event("wheel"));
        scroller.scrollTop = 300;
        scroller.dispatchEvent(new Event("scroll"));
      }),
    });
    expect(result.top).toBe(300);
  });

  it("lands at the end when a history ending in the reader's own row arrives", () => {
    // And the ordinary side of the same case: nobody touched anything, so it
    // still opens at the end.
    expect(openSession({ endsInUser: true }).fromBottom).toBe(0);
  });

  it("lands at the end when the conversation arrives already laid out", () => {
    // A short conversation, or one Chrome sizes on the first pass: no estimate
    // to correct, only the arrival. The arrival is itself a resize — card alone
    // to card plus rows — so the observer still acts here; what the case holds
    // is that the open does not depend on a LATER growth to land.
    expect(openSession({ duringGap: wheel, arrivesPainted: true }).fromBottom).toBe(0);
  });

  it("obeys a selection made in the conversation once it is on screen", () => {
    // The boundary the open must not cross. A selection made in the rows that
    // have just arrived is the reader holding content still, and every pinning
    // path owes it the same stand-down it owes at any other moment — the open
    // is a reason to place a conversation, never a licence to move text out
    // from under a cursor.
    const result = openSession({
      beforePaint: (scroller) => act(() => {
        const row = scroller.querySelector("[data-compact-content]")!;
        const range = document.createRange();
        range.selectNodeContents(row);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }),
    });
    expect(result.fromBottom).toBeGreaterThan(0);
  });

  it("leaves the reader where they are once the conversation is on screen", () => {
    // The other half of the promise, and the case that keeps the rest honest:
    // the open must not go on overriding a reader who has taken the scroll. A
    // gesture once the rows are up ends it, and their position stands.
    const result = openSession({
      afterPaint: (scroller) => {
        wheel(scroller);
        act(() => {
          scroller.scrollTop = 500;
          scroller.dispatchEvent(new Event("scroll"));
        });
      },
    });
    expect(result.top).toBe(500);
    expect(result.fromBottom).toBeGreaterThan(0);
  });

  it("leaves the reader where they are inside the session they are reading", () => {
    // Nothing about the open may reach an ordinary append in a session already
    // open: the reader scrolled back, a reply lands, and they do not move.
    show("s1");
    const messages = transcript("s1", 40);
    painted = true;
    const { container, rerender } = render(<MessageList messages={messages} isLoading={false} />);
    const scroller = container.querySelector<HTMLElement>("[data-chat-transcript]")!;
    installLayout(scroller);
    frames(scroller, 8);
    act(() => { scroller.dispatchEvent(new Event("wheel")); });
    act(() => {
      scroller.scrollTop = 400;
      scroller.dispatchEvent(new Event("scroll"));
    });

    rerender(<MessageList messages={[...messages, { role: "assistant", text: "s1 reply" } as ChatMessage]} isLoading={false} />);
    frames(scroller, 8);

    expect(scroller.scrollTop).toBe(400);
  });
});
