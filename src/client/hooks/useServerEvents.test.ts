import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useServerEvents } from "./useServerEvents.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

/**
 * Minimal fake EventSource: captures `addEventListener` handlers so a test can
 * synchronously dispatch a named SSE event with a JSON payload. Only the surface
 * `useServerEvents` touches is implemented.
 */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static last: FakeEventSource | null = null;
  static created = 0;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
    FakeEventSource.created += 1;
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {}
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
  /**
   * Simulate the spec's "fail the connection" path — the response was not
   * `200 text/event-stream` (e.g. the ingress's 502 page while the orchestrator
   * restarts), so readyState lands on CLOSED and the browser will NOT retry.
   */
  failConnection(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe("useServerEvents — session_agent_started", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    useSessionStore.setState({
      sessionId: "s1",
      isLoading: false,
      activity: undefined,
      activeRunnerSessions: new Set<string>(),
    });
    useSettingsStore.setState({
      providerAccountAuths: {},
      providerAccountAuthErrors: {},
      claudeAuthDiagnostics: {
        attemptId: null,
        active: false,
        phase: null,
        message: null,
        entries: [],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sets isLoading + activity when the active session's agent starts (system-initiated turn)", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_agent_started", { sessionId: "s1", activity: "Reviewing with Codex..." });
    });

    const store = useSessionStore.getState();
    expect(store.isLoading).toBe(true);
    expect(store.activity).toEqual({ label: "Reviewing with Codex..." });
    expect(store.activeRunnerSessions.has("s1")).toBe(true);
  });

  it("does NOT set isLoading when a different (background) session's agent starts", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_agent_started", { sessionId: "other" });
    });

    const store = useSessionStore.getState();
    expect(store.isLoading).toBe(false);
    expect(store.activity).toBeUndefined();
    // The sidebar "running" dot still tracks the background session.
    expect(store.activeRunnerSessions.has("other")).toBe(true);
  });
});

describe("useServerEvents — Claude auth diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    useSettingsStore.setState({
      claudeAuthDiagnostics: {
        attemptId: null,
        active: false,
        phase: null,
        message: null,
        entries: [],
      },
      providerAccountAuths: {},
      providerAccountAuthErrors: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Diagnostics are a provider-wide debug buffer, not a sign-in challenge, so
  // they keep working for an event that carries no account (docs/150 req 19 —
  // the provider-wide *challenge* slots are gone, diagnostics are not).
  it("stores progress and log events and keeps diagnostics after a failure", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_progress", {
        agentId: "claude",
        attemptId: "attempt-1",
        phase: "waiting_for_url",
        message: "Waiting for Claude CLI to print an authentication link.",
        elapsedMs: 1200,
      });
      es.emit("agent_auth_log", {
        agentId: "claude",
        attemptId: "attempt-1",
        timestamp: "2026-07-11T00:00:00.000Z",
        level: "info",
        source: "claude_stdout",
        message: "Browser did not open.",
      });
      es.emit("agent_auth_pending", {
        agentId: "claude",
        details: { kind: "code-paste-url", verificationUri: "https://claude.ai/oauth/authorize?code=true" },
      });
      es.emit("agent_auth_failed", {
        agentId: "claude",
        reason: "error",
        message: "Claude sign-in failed.",
      });
    });

    // docs/150 req 19 — nowhere for an account-less challenge to go, and no
    // provider-wide slot left to quietly absorb it.
    expect(useSettingsStore.getState().providerAccountAuths).toEqual({});
    expect(useSettingsStore.getState().claudeAuthDiagnostics).toMatchObject({
      attemptId: "attempt-1",
      active: false,
      phase: "failed",
      message: "Claude sign-in failed.",
    });
    expect(useSettingsStore.getState().claudeAuthDiagnostics.entries).toHaveLength(1);
  });

  it("keeps an account-scoped Claude login attached to its provider-account row", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_pending", {
        agentId: "claude",
        accountId: "acct-secondary",
        details: { kind: "code-paste-url", verificationUri: "https://claude.ai/oauth/authorize?secondary=true" },
      });
    });

    expect(useSettingsStore.getState().providerAccountAuths["claude:acct-secondary"]).toEqual({
      provider: "claude",
      accountId: "acct-secondary",
      verificationUri: "https://claude.ai/oauth/authorize?secondary=true",
    });

    act(() => {
      es.emit("agent_auth_complete", { agentId: "claude", accountId: "acct-secondary" });
    });
    expect(useSettingsStore.getState().providerAccountAuths["claude:acct-secondary"]).toBeUndefined();
  });
});

/**
 * The post-update page reload (`system_info.buildId` vs the baked client build
 * id) only ever fires on an SSE *connect*. So it depends entirely on the stream
 * coming back after the orchestrator is replaced — which native EventSource
 * does NOT guarantee: a non-200 response (the ingress's 502 page during the
 * restart window) *fails* the connection permanently. These cover our own
 * retry loop and the reload it enables.
 */
describe("useServerEvents — SSE reconnect after a failed connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    FakeEventSource.created = 0;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reopens the stream with backoff when the connection is failed (CLOSED)", () => {
    renderHook(() => useServerEvents());
    const first = FakeEventSource.last!;
    expect(FakeEventSource.created).toBe(1);

    act(() => {
      first.failConnection();
    });
    // Nothing yet — the retry is scheduled, not immediate.
    expect(FakeEventSource.created).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.created).toBe(2);
    expect(FakeEventSource.last).not.toBe(first);
    expect(first.closed).toBe(true);

    // Still down: the ladder backs off (1s, then 2s) rather than giving up.
    act(() => {
      FakeEventSource.last!.failConnection();
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.created).toBe(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.created).toBe(3);
  });

  it("does not schedule a retry while the browser's own auto-reconnect is in flight", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.readyState = FakeEventSource.CONNECTING;
      es.onerror?.();
      vi.advanceTimersByTime(30_000);
    });

    expect(FakeEventSource.created).toBe(1);
  });

  it("stops retrying once the hook unmounts", () => {
    const { unmount } = renderHook(() => useServerEvents());

    act(() => {
      FakeEventSource.last!.failConnection();
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(FakeEventSource.created).toBe(1);
  });

  // Must stay last: the reload guard in the hook is module-level and latches
  // once fired, so any later test in this file would see it already set.
  it("reloads the page when the reconnected orchestrator advertises a new build id", () => {
    vi.stubGlobal("__SHIPIT_CLIENT_BUILD_ID__", "old-build");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: Object.assign(Object.create(null), window.location, { reload }),
      writable: true,
    });

    renderHook(() => useServerEvents());
    const stranded = FakeEventSource.last!;

    // Orchestrator container is replaced: the stream is failed by the 502, then
    // our retry lands on the new process, which sends its build id on connect.
    act(() => {
      stranded.failConnection();
      vi.advanceTimersByTime(1000);
    });
    const reconnected = FakeEventSource.last!;
    // The reload can only come from a *new* connect — without the retry loop
    // there is no second stream and `system_info` is never re-delivered.
    expect(reconnected).not.toBe(stranded);

    act(() => {
      reconnected.emit("system_info", {
        processStartedAt: 1,
        buildId: "new-build",
        updateMode: "managed",
      });
    });

    expect(reload).toHaveBeenCalled();
  });
});

/**
 * Cross-session state — the sidebar's PR / CI indicators above all — is fed
 * ONLY by this stream: `/api/bootstrap` carries no PR state, so nothing but an
 * SSE (re)connect refreshes it. A mobile resume that reconnects the WebSocket
 * but not the SSE therefore looks healthy while every session's status is
 * frozen at its pre-background value until a full page reload. So the SSE has
 * to listen for the same foreground signals the WebSocket does.
 */
describe("useServerEvents — foreground reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    FakeEventSource.created = 0;
    setHidden(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** jsdom's `document.hidden` is read-only; redefine it per test. */
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  }

  it.each([
    ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
    // A standalone-PWA app-switch / bfcache restore surfaces as pageshow or
    // focus — the resume paths a visibility-only trigger misses.
    ["pageshow", () => window.dispatchEvent(new Event("pageshow"))],
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    ["online", () => window.dispatchEvent(new Event("online"))],
  ])("reopens the stream on %s", (_name, fire) => {
    renderHook(() => useServerEvents());
    expect(FakeEventSource.created).toBe(1);

    act(() => {
      fire();
    });

    expect(FakeEventSource.created).toBe(2);
  });

  it("opens one stream per resume, not one per event in the burst", () => {
    renderHook(() => useServerEvents());

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(FakeEventSource.created).toBe(2);

    // A later, genuinely separate resume is not swallowed by the coalesce window.
    act(() => {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(FakeEventSource.created).toBe(3);
  });

  it("ignores foreground events fired while the page is still hidden", () => {
    renderHook(() => useServerEvents());
    setHidden(true);

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(FakeEventSource.created).toBe(1);
  });
});
