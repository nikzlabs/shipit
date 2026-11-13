import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useServerEvents } from "./useServerEvents.js";
import { useSessionStore } from "../stores/session-store.js";

// docs/342-transient-provider-retry req 9 — how the chat learns a continuation waits, and stays right.

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static last: FakeEventSource | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener(): void {}
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) } as MessageEvent);
  }
  open(): void { this.onopen?.(); }
  failConnection(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const AT = "2026-11-13T10:00:30.000Z";

describe("useServerEvents — a waiting automatic continuation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    useSessionStore.setState({ sessions: [], allSessions: [], transientRetries: {} });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records the server's event, a cancel included", () => {
    renderHook(() => useServerEvents());
    act(() => { FakeEventSource.last!.emit("session_transient_retry", { sessionId: "s1", transientRetryAt: AT }); });
    expect(useSessionStore.getState().transientRetries).toEqual({ s1: AT });
    act(() => { FakeEventSource.last!.emit("session_transient_retry", { sessionId: "s1", transientRetryAt: null }); });
    expect(useSessionStore.getState().transientRetries).toEqual({ s1: null });
  });

  it("lets a later session list speak for the sessions it carries", () => {
    renderHook(() => useServerEvents());
    act(() => {
      FakeEventSource.last!.emit("session_transient_retry", { sessionId: "s1", transientRetryAt: AT });
      FakeEventSource.last!.emit("session_transient_retry", { sessionId: "past-cap", transientRetryAt: AT });
      FakeEventSource.last!.emit("session_list", { sessions: [{ id: "s1", title: "", createdAt: "", lastUsedAt: "", remoteUrl: "" }] });
    });
    expect(useSessionStore.getState().transientRetries).toEqual({ "past-cap": AT });
  });

  it("forgets every event value on a reconnect and reads All sessions again", async () => {
    renderHook(() => useServerEvents());
    act(() => { FakeEventSource.last!.open(); });
    act(() => { FakeEventSource.last!.emit("session_transient_retry", { sessionId: "past-cap", transientRetryAt: AT }); });
    fetchMock.mockClear();

    act(() => { FakeEventSource.last!.failConnection(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    act(() => { FakeEventSource.last!.open(); });

    expect(useSessionStore.getState().transientRetries).toEqual({});
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/sessions/all")).toBe(true);
    });
  });
});
