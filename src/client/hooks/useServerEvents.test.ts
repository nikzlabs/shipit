import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useServerEvents } from "./useServerEvents.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { getParkedHarness, getSavedModelId } from "../utils/local-storage.js";
import { persistHarnessPick } from "../utils/harness-seed.js";

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
      claudeAuthDiagnostics: {},
    });
    useUiStore.setState({ toast: null });
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

/**
 * docs/235 — the sidebar's background-work marker is cross-session state, so it
 * has to arrive on the SSE. The connect snapshot alone only covers work that was
 * already outstanding when the stream opened; a `shipit agent run` consult
 * backgrounded afterwards reached only the viewers attached to that session's
 * WebSocket, so the session read as idle in the sidebar until it was opened.
 */
describe("useServerEvents — session_attention background work", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    useSessionStore.setState({
      sessionId: "s1",
      backgroundTaskSessions: new Map<string, string[]>(),
      awaitingPermissionSessions: new Set<string>(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("marks a session busy when background work starts in it, unopened", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_attention", {
        sessionId: "other",
        backgroundTasks: ["shipit agent run --agent codex"],
      });
    });

    expect(useSessionStore.getState().backgroundTaskSessions.get("other")).toEqual([
      "shipit agent run --agent codex",
    ]);
  });

  it("clears the marker when the list drains", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_attention", { sessionId: "other", backgroundTasks: ["npm test"] });
      es.emit("session_attention", { sessionId: "other", backgroundTasks: [] });
    });

    expect(useSessionStore.getState().backgroundTaskSessions.has("other")).toBe(false);
  });

  // The two live forms share one event name, so each must apply only its own
  // axis — a background-task transition that read a missing `awaitingPermission`
  // as `false` would silently drop an outstanding prompt's sidebar signal.
  it("leaves the awaiting-permission set alone", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_attention", { sessionId: "other", awaitingPermission: true });
      es.emit("session_attention", { sessionId: "other", backgroundTasks: ["npm test"] });
    });

    expect(useSessionStore.getState().awaitingPermissionSessions.has("other")).toBe(true);
  });

  // A reaped container can hold nothing outstanding, and the disposal paths
  // clear the runner's trackers directly with no draining event of their own —
  // so the marker would otherwise pulse on a dead session until the next connect.
  it("clears the marker when the session's container is reaped", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_attention", { sessionId: "other", backgroundTasks: ["Codex consult"] });
      es.emit("session_status", { sessionId: "other", running: false, reason: "idle-disposed" });
    });

    expect(useSessionStore.getState().backgroundTaskSessions.has("other")).toBe(false);
  });

  // The connect snapshot stays authoritative: it reconciles both sets wholesale
  // so a reconnect converges rather than merging onto stale entries.
  it("still reconciles both sets wholesale from the connect snapshot", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("session_attention", { sessionId: "gone", backgroundTasks: ["npm test"] });
      es.emit("session_attention", {
        awaitingPermissionSessionIds: [],
        backgroundTaskSessionIds: ["fresh"],
      });
    });

    const marker = useSessionStore.getState().backgroundTaskSessions;
    expect(marker.has("gone")).toBe(false);
    expect(marker.has("fresh")).toBe(true);
  });
});

describe("useServerEvents — Claude auth diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    useSettingsStore.setState({
      claudeAuthDiagnostics: {},
      providerAccountAuths: {},
      providerAccountAuthErrors: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("stores progress and log events under the account they name, and keeps them after a failure", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_progress", {
        loginId: "anthropic-oauth",
        accountId: "acct-a",
        attemptId: "attempt-1",
        phase: "waiting_for_url",
        message: "Waiting for Claude CLI to print an authentication link.",
        elapsedMs: 1200,
      });
      es.emit("agent_auth_log", {
        loginId: "anthropic-oauth",
        accountId: "acct-a",
        attemptId: "attempt-1",
        timestamp: "2026-07-11T00:00:00.000Z",
        level: "info",
        source: "claude_stdout",
        message: "Browser did not open.",
      });
      es.emit("agent_auth_pending", {
        loginId: "anthropic-oauth",
        accountId: "acct-a",
        details: { kind: "code-paste-url", verificationUri: "https://claude.ai/oauth/authorize?code=true" },
      });
      es.emit("agent_auth_failed", {
        loginId: "anthropic-oauth",
        accountId: "acct-a",
        reason: "error",
        message: "Claude sign-in failed.",
      });
    });

    const diagnostics = useSettingsStore.getState().claudeAuthDiagnostics;
    expect(diagnostics["acct-a"]).toMatchObject({
      attemptId: "attempt-1",
      active: false,
      phase: "failed",
      message: "Claude sign-in failed.",
    });
    expect(diagnostics["acct-a"]?.entries).toHaveLength(1);
    // docs/150 — the buffer is keyed by account, so nothing leaks into a
    // sibling row's slot.
    expect(Object.keys(diagnostics)).toEqual(["acct-a"]);
  });

  // docs/150 — a second account's attempt gets its own buffer. It cannot happen
  // concurrently today (`startAccountAuth` refuses a second per-provider
  // sign-in with a 409), which is exactly why the scoping has to live in the
  // data rather than depend on that guard holding.
  it("keeps two accounts' diagnostics apart", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_log", {
        loginId: "anthropic-oauth",
        accountId: "acct-a",
        attemptId: "attempt-a",
        timestamp: "2026-07-11T00:00:00.000Z",
        level: "info",
        source: "claude_stdout",
        message: "A's output.",
      });
      es.emit("agent_auth_log", {
        loginId: "anthropic-oauth",
        accountId: "acct-b",
        attemptId: "attempt-b",
        timestamp: "2026-07-11T00:00:01.000Z",
        level: "info",
        source: "claude_stdout",
        message: "B's output.",
      });
      es.emit("agent_auth_failed", {
        loginId: "anthropic-oauth",
        accountId: "acct-b",
        reason: "error",
        message: "B failed.",
      });
    });

    const diagnostics = useSettingsStore.getState().claudeAuthDiagnostics;
    expect(diagnostics["acct-a"]?.entries.map((e) => e.message)).toEqual(["A's output."]);
    expect(diagnostics["acct-b"]?.entries.map((e) => e.message)).toEqual(["B's output."]);
    // Only B's attempt ended.
    expect(diagnostics["acct-a"]?.phase).toBeNull();
    expect(diagnostics["acct-b"]?.phase).toBe("failed");
  });

  it("surfaces missing Claude credentials on the exact account", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_failed", {
        loginId: "anthropic-oauth",
        accountId: "acct-missing",
        reason: "missing_credentials",
      });
    });

    expect(useSettingsStore.getState().providerAccountAuthErrors["anthropic-oauth:acct-missing"])
      .toBe("Claude credentials are missing. Sign in again.");
    expect(useUiStore.getState().toast?.message).toBe("Claude credentials are missing. Sign in again.");
  });

  // Every sign-in flow is account-scoped since docs/150 req 19, so an unscoped
  // payload names no row that could render it. Dropping it is what keeps the
  // buffer's key meaningful.
  it("drops an unscoped diagnostics payload rather than pooling it", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_progress", {
        loginId: "anthropic-oauth",
        attemptId: "attempt-unscoped",
        phase: "waiting_for_url",
        message: "Waiting for Claude CLI to print an authentication link.",
      });
      es.emit("agent_auth_log", {
        loginId: "anthropic-oauth",
        attemptId: "attempt-unscoped",
        timestamp: "2026-07-11T00:00:00.000Z",
        level: "info",
        source: "claude_stdout",
        message: "Browser did not open.",
      });
    });

    expect(useSettingsStore.getState().claudeAuthDiagnostics).toEqual({});
    // docs/150 req 19 — nowhere for an account-less challenge to go either.
    expect(useSettingsStore.getState().providerAccountAuths).toEqual({});
  });

  it("keeps an account-scoped Claude login attached to its provider-account row", () => {
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    act(() => {
      es.emit("agent_auth_pending", {
        loginId: "anthropic-oauth",
        accountId: "acct-secondary",
        details: { kind: "code-paste-url", verificationUri: "https://claude.ai/oauth/authorize?secondary=true" },
      });
    });

    expect(useSettingsStore.getState().providerAccountAuths["anthropic-oauth:acct-secondary"]).toEqual({
      loginId: "anthropic-oauth",
      accountId: "acct-secondary",
      verificationUri: "https://claude.ai/oauth/authorize?secondary=true",
    });

    act(() => {
      es.emit("agent_auth_complete", { loginId: "anthropic-oauth", accountId: "acct-secondary" });
    });
    expect(useSettingsStore.getState().providerAccountAuths["anthropic-oauth:acct-secondary"]).toBeUndefined();
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

  /** The hidden→visible round trip a real app-switch performs. */
  function backgroundAndReturn(): void {
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setHidden(false);
  }

  it.each([
    ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
    // A standalone-PWA app-switch / bfcache restore surfaces as pageshow — a
    // resume path a visibility-only trigger misses.
    ["pageshow", () => window.dispatchEvent(new Event("pageshow"))],
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
      window.dispatchEvent(new Event("pageshow"));
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

  // The two channels must agree on what a resume is, or they drift back apart:
  // the WebSocket and this stream share `useForegroundSignal` precisely so a
  // bare window `focus` — which the preview iframe fires on every load — cannot
  // tear down a live stream here either. Each teardown re-sends the whole
  // connect snapshot (sessions, repos, PR statuses), so the storm was visible
  // across the sidebar as well as in the chat.
  it("does not tear down a live stream on an iframe focus steal", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    renderHook(() => useServerEvents());

    for (let i = 0; i < 5; i++) {
      act(() => {
        vi.advanceTimersByTime(1000); // clear the coalesce window
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
    }

    expect(FakeEventSource.created).toBe(1);
    hasFocus.mockRestore();
  });

  // The window itself losing and regaining system focus is a genuine resume —
  // and the SSE has to agree with the WebSocket about that, or the sidebar's
  // PR / CI indicators stay frozen while the chat looks healthy.
  it("reopens when focus returns from another window", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => useServerEvents());

    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(FakeEventSource.created).toBe(2);
    hasFocus.mockRestore();
  });

  it("still reopens on focus after the page was actually backgrounded", () => {
    renderHook(() => useServerEvents());

    act(() => {
      backgroundAndReturn();
      window.dispatchEvent(new Event("focus"));
    });

    expect(FakeEventSource.created).toBe(2);
  });

  it("still reopens on focus after pagehide", () => {
    renderHook(() => useServerEvents());

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(FakeEventSource.created).toBe(2);
  });

  // Nothing healthy to protect — the spec's "fail the connection" path left
  // this stream CLOSED with only our own backoff behind it, so returning to the
  // window is a good moment to short-circuit that wait.
  it("reopens on focus when the stream is already closed", () => {
    renderHook(() => useServerEvents());

    act(() => {
      FakeEventSource.last!.failConnection();
    });
    expect(FakeEventSource.created).toBe(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(FakeEventSource.created).toBe(2);
  });
});

/**
 * The auth redirect, in BOTH directions.
 *
 * `resolveAuthedSelection` moves the picker off a harness with no usable
 * credential and persists the move, because the seed is what the next session is
 * created from. It was also permanent: a Claude account that went `auth_failed`
 * for a few minutes — which the OAuth refresher classifies optimistically and
 * `markProviderAccountReauthenticated` exists to undo — silently moved every
 * future session to Codex, with nothing on screen ever saying so.
 */
describe("useServerEvents — agent_list auth redirect and its undo", () => {
  const model = (modelId: string, serviceId: string) => ({
    modelId,
    serviceId,
    serviceName: serviceId,
    billingMode: "sub" as const,
    label: modelId,
    canonicalModelKey: modelId,
  });
  const agentPayload = (id: string, runnable: boolean) =>
    id === "claude"
      ? {
          id,
          name: "Claude Code",
          installed: true,
          hasRunnableModels: runnable,
          models: ["claude-opus-5"],
          eligibleModels: [model("claude-opus-5", "anthropic")],
        }
      : {
          id,
          name: "Codex",
          installed: true,
          hasRunnableModels: runnable,
          models: ["gpt-5.6-sol"],
          eligibleModels: [model("gpt-5.6-sol", "openai")],
        };
  const emitAgents = (es: FakeEventSource, claudeRunnable: boolean) => {
    act(() => {
      es.emit("agent_list", {
        agents: [agentPayload("claude", claudeRunnable), agentPayload("codex", true)],
      });
    });
  };

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    localStorage.clear();
    useUiStore.setState({ activeAgentId: "claude", toast: null, agentList: [] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redirects, parks the displaced selection, and says so", () => {
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    renderHook(() => useServerEvents());

    emitAgents(FakeEventSource.last!, false);

    expect(useUiStore.getState().activeAgentId).toBe("codex");
    expect(localStorage.getItem("vibe-agent-id")).toBe("codex");
    expect(getParkedHarness()).toEqual({
      agentId: "claude",
      model: { modelId: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" },
    });
    expect(useUiStore.getState().toast?.message).toContain("Claude Code");
  });

  it("hands the harness back — with its model — once the credential returns", () => {
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    emitAgents(es, false);
    expect(useUiStore.getState().activeAgentId).toBe("codex");

    emitAgents(es, true);

    expect(useUiStore.getState().activeAgentId).toBe("claude");
    expect(localStorage.getItem("vibe-agent-id")).toBe("claude");
    expect(getSavedModelId()).toBe("claude-opus-5");
    expect(getParkedHarness()).toBeUndefined();
    expect(useUiStore.getState().toast?.message).toContain("available again");
  });

  it("does not re-park on a second redirect, so the user's own choice survives", () => {
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    emitAgents(es, false);
    // A second event while still down must not overwrite the park with "codex".
    emitAgents(es, false);

    expect(getParkedHarness()?.agentId).toBe("claude");
  });

  it("leaves a deliberate pick made while the harness was down alone", () => {
    // Choosing Codex while Claude is unreachable means it — the restore must not
    // yank the user back when Claude recovers. The pick clears the park.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    emitAgents(es, false);
    persistHarnessPick({ agentId: "codex", agents: useUiStore.getState().agentList });
    emitAgents(es, true);

    expect(localStorage.getItem("vibe-agent-id")).toBe("codex");
    expect(getSavedModelId()).toBe("gpt-5.6-sol");
  });
});

/**
 * The park describes the SEED, never the session being viewed.
 *
 * `activeAgentId` is synced to whichever session is open (`useConnectionSync`),
 * on purpose. Reading it as "the harness the user chose for new sessions" made
 * the redirect park a pair the user never picked, and made it re-announce itself
 * on every reconnect. Both were found by cross-backend review.
 */
describe("useServerEvents — the redirect acts on the seed, not the viewed session", () => {
  const model = (modelId: string, serviceId: string) => ({
    modelId,
    serviceId,
    serviceName: serviceId,
    billingMode: "sub" as const,
    label: modelId,
    canonicalModelKey: modelId,
  });
  const agentPayload = (id: string, runnable: boolean) =>
    id === "claude"
      ? {
          id,
          name: "Claude Code",
          installed: true,
          hasRunnableModels: runnable,
          models: ["claude-opus-5"],
          eligibleModels: [model("claude-opus-5", "anthropic")],
        }
      : {
          id,
          name: "Codex",
          installed: true,
          hasRunnableModels: runnable,
          models: ["gpt-5.6-sol"],
          eligibleModels: [model("gpt-5.6-sol", "openai")],
        };
  const emit = (es: FakeEventSource, claudeRunnable: boolean, codexRunnable = true) => {
    act(() => {
      es.emit("agent_list", {
        agents: [agentPayload("claude", claudeRunnable), agentPayload("codex", codexRunnable)],
      });
    });
  };

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    FakeEventSource.last = null;
    localStorage.clear();
    useUiStore.setState({ activeAgentId: "claude", toast: null, agentList: [] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("parks nothing when the viewed session's harness dies but the seed is untouched", () => {
    // Seed is Claude/Opus; the user is looking at an older Codex session, so
    // `activeAgentId` is codex. Codex's credential fails. The redirect writes
    // Claude/Opus back over Claude/Opus — it took nothing away — so parking
    // `{codex, Opus}` here would later restore an incoherent pair and replace
    // the user's Claude seed with Codex's first model.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    useUiStore.setState({ activeAgentId: "codex" });
    renderHook(() => useServerEvents());

    emit(FakeEventSource.last!, true, false);

    expect(getParkedHarness()).toBeUndefined();
    expect(useUiStore.getState().toast).toBeNull();
    expect(getSavedModelId()).toBe("claude-opus-5");
  });

  it("does not re-announce the redirect when a reconnect re-syncs the dead harness", () => {
    // After the redirect the seed is Codex. A WS reconnect sets `activeAgentId`
    // back to the viewed Claude session's harness, and the SSE reconnect's own
    // `agent_list` re-runs the same redirect — which used to raise the same
    // 12-second toast again, for the whole outage, every time the app was
    // foregrounded.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    renderHook(() => useServerEvents());
    const es = FakeEventSource.last!;

    emit(es, false);
    expect(useUiStore.getState().toast?.message).toContain("no usable credential");

    useUiStore.setState({ toast: null, activeAgentId: "claude" });
    emit(es, false);

    expect(useUiStore.getState().toast).toBeNull();
    expect(getParkedHarness()?.agentId).toBe("claude");
  });
});
