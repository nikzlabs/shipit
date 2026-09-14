import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useServerEvents } from "./useServerEvents.js";
import { useEgressStore } from "../stores/egress-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

/**
 * A setting changed somewhere else, and this viewer finds out
 * (docs/299-agent-settings-access, plan.md → Apply goes through a shared layer).
 *
 * Two halves, and the second is the one a broadcast alone cannot cover: a
 * broadcast does not reach a viewer that was away, and the catch-up cannot hang
 * off chat-history hydration because that path needs an active session while the
 * Settings dialog can be open on the home screen. So it hangs off the GLOBAL
 * connection's recovery, which is the only signal every viewer gets.
 */

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

const BOOTSTRAP = {
  sessions: [],
  agents: [],
  templates: [],
  githubStatus: { authenticated: false },
  settings: {
    gitIdentity: { name: "Ada", email: "ada@example.com" },
    systemPrompt: "",
    enableSubAgents: false,
    memoryBudgetMb: 8192,
  },
};

describe("useServerEvents — settings changed elsewhere", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(BOOTSTRAP),
    });
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.setState({ enableSubAgents: true, memoryBudgetMb: null });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-reads the settings when the server says one moved", async () => {
    renderHook(() => useServerEvents());
    fetchMock.mockClear();

    act(() => {
      FakeEventSource.last!.emit("settings_changed", { keys: ["enableSubAgents"] });
    });
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().enableSubAgents).toBe(false);
    });
    expect(useSettingsStore.getState().memoryBudgetMb).toBe(8192);
  });

  it("refreshes the egress store only for a network key, and only when something is looking", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useEgressStore.setState({ loaded: true, refresh });
    renderHook(() => useServerEvents());

    act(() => {
      FakeEventSource.last!.emit("settings_changed", { keys: ["enableSubAgents"] });
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => {
      FakeEventSource.last!.emit("settings_changed", { keys: ["network.egress.hosts"] });
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Nothing has opened the Network tab: refreshing would fetch for a surface
    // no one is reading.
    refresh.mockClear();
    useEgressStore.setState({ loaded: false });
    act(() => {
      FakeEventSource.last!.emit("settings_changed", { keys: ["network.egress.hosts"] });
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-reads them again when the global connection recovers, for a viewer that was away", async () => {
    renderHook(() => useServerEvents());
    // The first open is the bootstrap's own read, not a recovery.
    act(() => { FakeEventSource.last!.open(); });
    fetchMock.mockClear();

    act(() => { FakeEventSource.last!.failConnection(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    act(() => { FakeEventSource.last!.open(); });

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/bootstrap"))).toBe(true);
      expect(useSettingsStore.getState().enableSubAgents).toBe(false);
    });
  });
});
