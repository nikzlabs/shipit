import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useWebSocket,
  AWAY_LIMIT_MS,
  PROBE_TIMEOUT_MS,
  STALLED_HANDSHAKE_MS,
} from "./useWebSocket.js";

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

  // A real socket reports the close to its handler. The hook's own teardown
  // detaches them first; a close it makes deliberately does not, and that is
  // the path where `onclose` deciding to reconnect has to be suppressed.
  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
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

function pings(ws: FakeWebSocket): { type: string; id: string }[] {
  return (ws.send.mock.calls as [string][])
    .map(([raw]) => JSON.parse(raw) as { type: string; id: string })
    .filter((msg) => msg.type === "ping");
}

/** The socket answers the liveness probe it was sent. */
function answerProbe(ws: FakeWebSocket): void {
  const ping = pings(ws).at(-1);
  ws.simulateMessage({ type: "pong", id: ping?.id ?? "unsent" });
}

/** Let an unanswered probe run out, and let its `.then` run. */
async function probeGoesUnanswered(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS); });
}

/** Hidden for `ms`, then back. */
async function awayHiddenFor(ms: number): Promise<void> {
  act(() => { setHidden(true); document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  act(() => { setHidden(false); document.dispatchEvent(new Event("visibilitychange")); });
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

  it("leaves a handshake that is still young alone on a resume, and replaces it once it has stalled", () => {
    renderHook(() => useWebSocket("ws://test"));

    const connectingSocket = latestWs();
    expect(connectingSocket.readyState).toBe(FakeWebSocket.CONNECTING);

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Replacing it here restarts the handshake it is waiting for, which on a
    // slow link is the only thing it ever achieves.
    expect(connectingSocket.closed).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(countBefore);

    void act(() => vi.advanceTimersByTime(STALLED_HANDSHAKE_MS));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("coalesces the visibilitychange + focus burst one reactivation fires into a single probe", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => { window.dispatchEvent(new Event("pageshow")); });

    expect(pings(ws).length).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("probes again once the coalescing window has passed", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { backgroundAndReturn(); window.dispatchEvent(new Event("focus")); });
    act(() => answerProbe(ws));
    expect(pings(ws).length).toBe(1);

    void act(() => vi.advanceTimersByTime(5000));
    act(() => { backgroundAndReturn(); window.dispatchEvent(new Event("focus")); });
    expect(pings(ws).length).toBe(2);
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

  // returning from another window still has to establish that, but by asking.
  it("probes rather than replaces when focus returns from another window", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      windowKeptSystemFocus = false;
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(pings(ws).length).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(countBefore);

    act(() => answerProbe(ws));
    await probeGoesUnanswered();
    expect(ws.closed).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  // `readyState` reads OPEN over a socket the OS already killed, so a resume
  // may keep one only once it has answered.
  it("keeps a socket that answers the probe after the page was backgrounded", async () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => answerProbe(ws));
    await probeGoesUnanswered();

    expect(FakeWebSocket.instances.length).toBe(countBefore);
    expect(ws.closed).toBe(false);
    expect(result.current.status).toBe("open");
  });

  it("replaces a socket that does not answer the probe", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(FakeWebSocket.instances.length).toBe(countBefore);

    await probeGoesUnanswered();
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
    expect(ws.closed).toBe(true);
  });

  it("any inbound frame answers the probe, not only a pong", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => ws.simulateMessage({ type: "git_log", entries: [] }));
    await probeGoesUnanswered();

    expect(FakeWebSocket.instances.length).toBe(countBefore);
  });

  it("consumes the pong instead of surfacing it as a message", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => answerProbe(ws));

    expect(result.current.lastMessage).toBeNull();
    expect(result.current.drainMessages()).toHaveLength(0);
  });

  // The page stayed visible throughout, so nothing released the socket; the
  // away limit is the trust cap here, and past it the socket is not asked.
  it("replaces an open socket without probing when the window was unfocused past the away limit", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    const countBefore = FakeWebSocket.instances.length;
    act(() => {
      windowKeptSystemFocus = false;
      window.dispatchEvent(new Event("blur"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(AWAY_LIMIT_MS); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(pings(ws)).toHaveLength(0);
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  // never fires it, so it is safe evidence that the resume is real.
  it("probes on focus after pagehide", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { window.dispatchEvent(new Event("pagehide")); });
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(pings(ws).length).toBe(1);
  });

  it("releases the socket once the page has been hidden for the away limit", async () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { setHidden(true); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(AWAY_LIMIT_MS - 1); });
    expect(ws.closed).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(ws.closed).toBe(true);
    expect(result.current.status).toBe("closed");

    // A socket given up on purpose must not reconnect behind a hidden page.
    const countAfterRelease = FakeWebSocket.instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(FakeWebSocket.instances.length).toBe(countAfterRelease);

    act(() => { setHidden(false); document.dispatchEvent(new Event("visibilitychange")); });
    expect(FakeWebSocket.instances.length).toBe(countAfterRelease + 1);
  });

  // A confirmation shown to the user must not outrun the wire, and a socket
  // mid-probe has not yet shown there is a wire.
  it("refuses a send while the socket is under a probe, and accepts it once answered", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();
    expect(result.current.send({ type: "send_message" })).toBe(true);

    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(result.current.send({ type: "send_message" })).toBe(false);

    act(() => answerProbe(ws));
    expect(result.current.send({ type: "send_message" })).toBe(true);
  });

  // Nothing hid — it was born hidden — so there is no `onAway` to arm it.
  it("releases a socket opened while the page was already hidden", async () => {
    setHidden(true);
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    await act(async () => { await vi.advanceTimersByTimeAsync(AWAY_LIMIT_MS); });
    expect(ws.closed).toBe(true);
  });

  it("re-arms the release for a session switched to while hidden", async () => {
    setHidden(true);
    const { rerender } = renderHook(({ url }) => useWebSocket(url), {
      initialProps: { url: "ws://one" },
    });
    act(() => latestWs().simulateOpen());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    rerender({ url: "ws://two" });
    act(() => latestWs().simulateOpen());
    const second = latestWs();

    await act(async () => { await vi.advanceTimersByTimeAsync(AWAY_LIMIT_MS); });
    expect(second.closed).toBe(true);
  });

  it("does not release a socket whose page came back before the away limit", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    await awayHiddenFor(AWAY_LIMIT_MS - 1000);
    act(() => answerProbe(ws));
    await act(async () => { await vi.advanceTimersByTimeAsync(AWAY_LIMIT_MS); });

    expect(ws.closed).toBe(false);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("reconnects on focus when the socket is already closed", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    act(() => latestWs().simulateClose());

    const countBefore = FakeWebSocket.instances.length;
    act(() => { window.dispatchEvent(new Event("focus")); });

    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("one backgrounding buys one probe, not one per subsequent focus", () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());
    const ws = latestWs();

    act(() => { backgroundAndReturn(); });
    act(() => { window.dispatchEvent(new Event("focus")); });
    act(() => answerProbe(ws));
    expect(pings(ws).length).toBe(1);

    // The iframe storm that follows the resume must not keep asking.
    void act(() => vi.advanceTimersByTime(5000));
    for (let i = 0; i < 3; i++) {
      act(() => { iframeFocusSteal(); });
      void act(() => vi.advanceTimersByTime(1000));
    }
    expect(pings(ws).length).toBe(1);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("retries a stalled handshake before backoff would, without restarting a young one", async () => {
    renderHook(() => useWebSocket("ws://test"));
    act(() => latestWs().simulateOpen());

    const countBefore = FakeWebSocket.instances.length;
    // Away past the limit, so the resume replaces the socket outright.
    await awayHiddenFor(AWAY_LIMIT_MS);
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);

    const handshake = latestWs();
    expect(handshake.readyState).toBe(FakeWebSocket.CONNECTING);

    // The retry that used to fire here killed the handshake in flight.
    void act(() => vi.advanceTimersByTime(STALLED_HANDSHAKE_MS - 1));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 1);
    expect(handshake.closed).toBe(false);

    void act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 2);

    act(() => latestWs().simulateOpen());
    void act(() => vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances.length).toBe(countBefore + 2);
  });
});
