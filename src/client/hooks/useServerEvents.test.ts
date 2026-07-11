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
  static last: FakeEventSource | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {}
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(data) } as MessageEvent);
    }
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
    useSessionStore.setState({ authUrl: null });
    useSettingsStore.setState({
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

  it("stores progress and log events, then keeps diagnostics when failure clears authUrl", () => {
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

    expect(useSessionStore.getState().authUrl).toBeNull();
    expect(useSettingsStore.getState().claudeAuthDiagnostics).toMatchObject({
      attemptId: "attempt-1",
      active: false,
      phase: "failed",
      message: "Claude sign-in failed.",
    });
    expect(useSettingsStore.getState().claudeAuthDiagnostics.entries).toHaveLength(1);
  });
});
