import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket.js";

// --- Minimal WebSocket stub ---

type WsHandler = ((ev: { data: string }) => void) | null;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
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
  }

  // Helpers for tests
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as any);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
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
    act(() => result.current.send({ type: "test" }));
    expect(ws.send).toHaveBeenCalledWith('{"type":"test"}');
  });

  it("does not send when not connected", () => {
    const { result } = renderHook(() => useWebSocket("ws://test"));
    const ws = latestWs();
    act(() => result.current.send({ type: "test" }));
    expect(ws.send).not.toHaveBeenCalled();
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
});
