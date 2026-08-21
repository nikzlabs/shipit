import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket.js";

// --- Minimal WebSocket stub ---

type WsHandler = ((ev: { data: string }) => void) | null;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: WsHandler = null;
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Helpers for tests
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as any);
  }
}

/** jsdom's `document.hidden` is read-only; drive it through this instead. */
let pageHidden = false;
function setHidden(hidden: boolean): void {
  pageHidden = hidden;
}

/**
 * `document.hasFocus()` at blur time is what separates "the preview iframe took
 * focus" (true — the window keeps system focus) from "the browser window lost
 * focus to another app" (false). See `useForegroundSignal`.
 */
let windowKeptSystemFocus = true;

/** The preview iframe stealing focus, then `MessageInput` reclaiming it. */
function iframeFocusSteal(): void {
  windowKeptSystemFocus = true;
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
}

/** The hidden→visible round trip a real app-switch performs. */
function backgroundAndReturn(): void {
  setHidden(true);
  document.dispatchEvent(new Event("visibilitychange"));
  setHidden(false);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
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
  vi.unstubAllGlobals();
});

function latestWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe("useWebSocket", () => {
  it("starts with connecting status", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    expect(result.current.status).toBe("connecting");
  });

  it("transitions to open when WebSocket connects", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    expect(result.current.status).toBe("open");
  });

  it("transitions to closed when WebSocket disconnects", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());
    expect(result.current.status).toBe("closed");
  });

  it("sends JSON data when connected", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();
    act(() => ws.simulateOpen());
    act(() => { result.current.send({ type: "test" }); });
    expect(ws.send).toHaveBeenCalledWith('{"type":"test"}');
  });

  it("does not send when not connected", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();
    act(() => { result.current.send({ type: "test" }); });
    expect(ws.send).not.toHaveBeenCalled();
  });

  // A dropped frame used to be indistinguishable from a delivered one, which is
  // what let the action-checklist card render "Submitted · N sent" for a message
  // that never left the browser. `send` now reports what it actually did.
  it("reports true only when the bytes went to an OPEN socket", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();

    let delivered: boolean | undefined;
    act(() => { delivered = result.current.send({ type: "test" }); });
    expect(delivered).toBe(false); // still CONNECTING

    act(() => ws.simulateOpen());
    act(() => { delivered = result.current.send({ type: "test" }); });
    expect(delivered).toBe(true);

    act(() => ws.simulateClose());
    act(() => { delivered = result.current.send({ type: "test" }); });
    expect(delivered).toBe(false);
  });

  it("reports false when the socket throws mid-write", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();
    act(() => ws.simulateOpen());
    ws.send.mockImplementationOnce(() => {
      throw new DOMException("InvalidStateError");
    });

    let delivered: boolean | undefined;
    act(() => { delivered = result.current.send({ type: "test" }); });
    expect(delivered).toBe(false);
  });

  it("sets lastMessage on incoming message", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateMessage({ hello: "world" }));
    expect(result.current.lastMessage).not.toBeNull();
  });

  it("drainMessages returns all queued messages and clears the queue", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    // Send multiple messages in a single act (simulates burst between renders)
    act(() => {
      latestWs().simulateMessage({ type: "a" });
      latestWs().simulateMessage({ type: "b" });
      latestWs().simulateMessage({ type: "c" });
    });

    // Drain should return all 3 messages
    let drained: MessageEvent[] = [];
    act(() => { drained = result.current.drainMessages(); });
    expect(drained).toHaveLength(3);

    // Subsequent drain should return empty
    let second: MessageEvent[] = [];
    act(() => { second = result.current.drainMessages(); });
    expect(second).toHaveLength(0);
  });

  it("drops undrained messages when the connection URL changes", () => {
    const { result, rerender } = renderHook(
      ({ url }) => useWebSocket(url),
      { initialProps: { url: "ws://session-a" } },
    );
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateMessage({ type: "agent_event", session: "a" }));

    rerender({ url: "ws://session-b" });

    expect(latestWs().url).toBe("ws://session-b");
    expect(result.current.lastMessage).toBeNull();
    expect(result.current.drainMessages()).toEqual([]);
  });

  /**
   * `status` is React state, so on the render that CHANGES `url` it would
   * otherwise still report the previous socket's `"open"` — a session switch
   * renders `"open"` once for a socket belonging to the outgoing session and
   * about to be torn down. Consumers key real work off this (history
   * hydration, pending sends), so the stale value made them act for the
   * incoming session over the outgoing session's connection.
   */
  it("reports connecting for a URL whose socket has not been opened yet", () => {
    // Recorded per render, because the stale value is only observable DURING
    // the render that changes the URL — `rerender` flushes the effect that
    // corrects it, so reading `result.current` afterwards always looks right.
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ url }) => {
        const ws = useWebSocket(url);
        seen.push(ws.status);
        return ws;
      },
      { initialProps: { url: "ws://session-a" } },
    );
    act(() => latestWs().simulateOpen());
    expect(result.current.status).toBe("open");

    seen.length = 0;
    rerender({ url: "ws://session-b" });
    // Not one render may claim the outgoing session's socket is open.
    expect(seen).not.toContain("open");

    act(() => latestWs().simulateOpen());
    expect(result.current.status).toBe("open");
  });

  it("keeps reporting a live socket's status across a reconnect on the same URL", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    act(() => result.current.reconnect());
    expect(result.current.status).toBe("connecting");
    act(() => latestWs().simulateOpen());
    expect(result.current.status).toBe("open");
  });

  // --- Reconnection ---

  it("increments reconnectAttempt on close", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    expect(result.current.reconnectAttempt).toBe(0);

    act(() => latestWs().simulateClose());
    expect(result.current.reconnectAttempt).toBe(1);
  });

  it("auto-reconnects after backoff delay", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const wsBefore = FakeWebSocket.instances.length;
    act(() => latestWs().simulateClose());

    // Before delay: no new WebSocket yet
    expect(FakeWebSocket.instances.length).toBe(wsBefore);

    // After 2s (first backoff): new WebSocket created
    void act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances.length).toBe(wsBefore + 1);
  });

  it("uses exponential backoff: 2s, 4s, 8s", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    // First disconnect — 2s backoff
    act(() => latestWs().simulateClose());
    const count1 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances.length).toBe(count1 + 1);

    // Second disconnect — 4s backoff
    act(() => latestWs().simulateClose());
    const count2 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(2000)); // Too early
    expect(FakeWebSocket.instances.length).toBe(count2);
    void act(() => vi.advanceTimersByTime(2000)); // 4s total
    expect(FakeWebSocket.instances.length).toBe(count2 + 1);

    // Third disconnect — 8s backoff
    act(() => latestWs().simulateClose());
    const count3 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(4000)); // Too early
    expect(FakeWebSocket.instances.length).toBe(count3);
    void act(() => vi.advanceTimersByTime(4000)); // 8s total
    expect(FakeWebSocket.instances.length).toBe(count3 + 1);
  });

  it("resets reconnectAttempt on successful reconnection", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());
    expect(result.current.reconnectAttempt).toBe(1);

    // Reconnect fires
    void act(() => vi.advanceTimersByTime(2000));
    act(() => latestWs().simulateOpen());
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("caps backoff at 30 seconds", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    // Create many failed reconnect attempts to push backoff high
    for (let i = 0; i < 10; i++) {
      act(() => latestWs().simulateClose());
      void act(() => vi.advanceTimersByTime(30_000));
    }

    // 10th attempt — backoff would be 2*2^10 = 2048s without cap
    // With cap it should be 30s
    act(() => latestWs().simulateClose());
    const count = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances.length).toBe(count + 1);
  });

  // --- Manual reconnect ---

  it("reconnect() triggers immediate reconnection", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());

    const countBefore = FakeWebSocket.instances.length;
    act(() => result.current.reconnect());
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("reconnect() resets attempt counter", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());
    expect(result.current.reconnectAttempt).toBe(1);

    act(() => result.current.reconnect());
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("reconnect() cancels pending backoff timer", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());

    // Manual reconnect — should cancel the pending 2s backoff timer
    const countAfterManual = FakeWebSocket.instances.length;
    act(() => result.current.reconnect());
    expect(FakeWebSocket.instances.length).toBe(countAfterManual + 1);

    // Advancing timers should NOT cause another reconnect
    const countAfterAll = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(5000));
    expect(FakeWebSocket.instances.length).toBe(countAfterAll);
  });

  it("foreground visibility forces a fresh socket even when the current socket is still connecting", () => {
    renderHook(() => useWebSocket("ws://test"));

    const connectingSocket = latestWs();
    expect(connectingSocket.readyState).toBe(FakeWebSocket.CONNECTING);

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(connectingSocket.closed).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("coalesces the visibilitychange + focus burst one reactivation fires into a single reconnect", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    // A window reactivation fires these back to back. Each one used to tear the
    // socket down and open another, so a single reactivation produced several
    // server attaches and several overlapping history loads — the window in
    // which a stale load clobbers a fresh transcript.
    // Separate `act()` calls on purpose: the browser delivers these in
    // separate event-loop turns, so React commits (and the socket effect runs)
    // between them. Batching them into one act would hide the bug.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => { window.dispatchEvent(new Event("pageshow")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("reconnects again once the coalescing window has passed", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); window.dispatchEvent(new Event("focus")); });
    act(() => latestWs().simulateOpen());
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

    // A later, genuinely separate reactivation is not swallowed.
    void act(() => vi.advanceTimersByTime(5000));
    act(() => latestWs().simulateOpen());
    const countAfterRetries = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); window.dispatchEvent(new Event("focus")); });
    expect(FakeWebSocket.instances.length).toBe(countAfterRetries + 1);
  });

  // --- `focus` is not, on its own, a foreground signal ---
  //
  // The window `focus` event also fires when focus returns from an iframe to
  // the top-level document. The preview iframe does that on every load, and
  // `MessageInput` then reclaims focus to the textarea, firing it again — so
  // wiring `focus` straight to "reconnect" produced exactly one forced
  // reconnect per second (the coalesce window) on a perfectly healthy socket.
  // Each one re-ran the whole attach burst: the preview flicker, plus a
  // composer that flipped disabled/enabled with the socket status.

  it("does not tear down a live socket on an iframe focus steal", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const openSocket = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    for (let i = 0; i < 5; i++) {
      act(() => { iframeFocusSteal(); });
      void act(() => vi.advanceTimersByTime(1000)); // clear the coalesce window
    }

    expect(FakeWebSocket.instances.length).toBe(countBefore);
    expect(openSocket.closed).toBe(false);
  });

  it("does not tear down a still-connecting socket on an iframe focus steal", () => {
    renderHook(() => useWebSocket("ws://test"));
    const connectingSocket = latestWs();
    expect(connectingSocket.readyState).toBe(FakeWebSocket.CONNECTING);

    const countBefore = FakeWebSocket.instances.length;
    act(() => { iframeFocusSteal(); });

    expect(FakeWebSocket.instances.length).toBe(countBefore);
    expect(connectingSocket.closed).toBe(false);
  });

  // Not to be confused with the above: the browser window itself losing and
  // regaining system focus IS a resume, and on desktop it is often the only
  // signal of one (the window stayed visible, so no `visibilitychange`). A
  // socket the OS killed while the user was in another app still reads OPEN, so
  // this must force a fresh one.
  it("reconnects when focus returns from another window, even on a live socket", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      windowKeptSystemFocus = false;
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  // The recovery path the `focus` listener exists for in the first place: a
  // mobile app-switch or bfcache restore leaves `readyState` reading OPEN over
  // a socket the OS already killed, so the resume MUST still force a fresh one.
  it("still reconnects on focus after the page was actually backgrounded", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  // `pagehide` is the bfcache/app-switch signal that does NOT come with a
  // `visibilitychange` the page is awake to process — an iframe focus change
  // never fires it, so it is safe evidence that the resume is real.
  it("still reconnects on focus after pagehide", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  // Nothing healthy to protect: returning to the window is a good moment to
  // short-circuit the backoff ladder.
  it("reconnects on focus when the socket is already closed", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("one backgrounding buys one reconnect, not one per subsequent focus", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => latestWs().simulateOpen());
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

    // The iframe storm that follows the resume must not keep reconnecting.
    void act(() => vi.advanceTimersByTime(5000));
    act(() => latestWs().simulateOpen());
    const countAfterResume = FakeWebSocket.instances.length;
    for (let i = 0; i < 3; i++) {
      act(() => { iframeFocusSteal(); });
      void act(() => vi.advanceTimersByTime(1000));
    }
    expect(FakeWebSocket.instances.length).toBe(countAfterResume);
  });

  it("foreground reconnect retries quickly before normal backoff if the socket is not open", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

    void act(() => vi.advanceTimersByTime(299));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

    void act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 2);

    act(() => latestWs().simulateOpen());
    void act(() => vi.advanceTimersByTime(3000));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 2);
  });
});
