import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket.js";

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

let pageHidden = false;
function setHidden(hidden: boolean): void {
  pageHidden = hidden;
}

let windowKeptSystemFocus = true;

function iframeFocusSteal(): void {
  windowKeptSystemFocus = true;
  window.dispatchEvent(new Event("blur"));
  window.dispatchEvent(new Event("focus"));
}

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

  // that never left the browser. `send` now reports what it actually did.
  it("reports true only when the bytes went to an OPEN socket", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();

    let delivered: boolean | undefined;
    act(() => { delivered = result.current.send({ type: "test" }); });
    expect(delivered).toBe(false);                    

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

    act(() => {
      latestWs().simulateMessage({ type: "a" });
      latestWs().simulateMessage({ type: "b" });
      latestWs().simulateMessage({ type: "c" });
    });

    let drained: MessageEvent[] = [];
    act(() => { drained = result.current.drainMessages(); });
    expect(drained).toHaveLength(3);

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

  it("reports connecting for a URL whose socket has not been opened yet", () => {
    // Recorded per render, because the stale value is only observable DURING

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

    expect(FakeWebSocket.instances.length).toBe(wsBefore);

    void act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances.length).toBe(wsBefore + 1);
  });

  it("uses exponential backoff: 2s, 4s, 8s", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    act(() => latestWs().simulateClose());
    const count1 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances.length).toBe(count1 + 1);

    act(() => latestWs().simulateClose());
    const count2 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(2000));             
    expect(FakeWebSocket.instances.length).toBe(count2);
    void act(() => vi.advanceTimersByTime(2000));            
    expect(FakeWebSocket.instances.length).toBe(count2 + 1);

    act(() => latestWs().simulateClose());
    const count3 = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(4000));             
    expect(FakeWebSocket.instances.length).toBe(count3);
    void act(() => vi.advanceTimersByTime(4000));            
    expect(FakeWebSocket.instances.length).toBe(count3 + 1);
  });

  it("resets reconnectAttempt on successful reconnection", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());
    expect(result.current.reconnectAttempt).toBe(1);

    void act(() => vi.advanceTimersByTime(2000));
    act(() => latestWs().simulateOpen());
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("caps backoff at 30 seconds", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    for (let i = 0; i < 10; i++) {
      act(() => latestWs().simulateClose());
      void act(() => vi.advanceTimersByTime(30_000));
    }

    act(() => latestWs().simulateClose());
    const count = FakeWebSocket.instances.length;
    void act(() => vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances.length).toBe(count + 1);
  });

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

    const countAfterManual = FakeWebSocket.instances.length;
    act(() => result.current.reconnect());
    expect(FakeWebSocket.instances.length).toBe(countAfterManual + 1);

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

    void act(() => vi.advanceTimersByTime(5000));
    act(() => latestWs().simulateOpen());
    const countAfterRetries = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); window.dispatchEvent(new Event("focus")); });
    expect(FakeWebSocket.instances.length).toBe(countAfterRetries + 1);
  });

  it("does not tear down a live socket on an iframe focus steal", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const openSocket = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    for (let i = 0; i < 5; i++) {
      act(() => { iframeFocusSteal(); });
      void act(() => vi.advanceTimersByTime(1000));                             
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

  // a socket the OS already killed, so the resume MUST still force a fresh one.
  it("still reconnects on focus after the page was actually backgrounded", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  // never fires it, so it is safe evidence that the resume is real.
  it("still reconnects on focus after pagehide", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

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
