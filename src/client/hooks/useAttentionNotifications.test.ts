import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useAttentionNotifications } from "./useAttentionNotifications.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";
import type { SessionInfo } from "../../server/shared/types.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSessionStore.setState({
    sessions: [],
    activeRunnerSessions: new Set<string>(),
    backgroundTaskSessions: new Map<string, string[]>(),
  });
  usePrStore.setState({ cardBySession: {}, statusBySession: {} });
  useSettingsStore.setState({ autoFixCi: false, autoResolveConflicts: false });
});

/**
 * Attention notifications only fire once the reason has held for the settle
 * window (see `ATTENTION_SETTLE_MS`), so every assertion has to run the clock
 * forward first. Comfortably longer than the window.
 */
function settle(): void {
  act(() => { vi.advanceTimersByTime(5000); });
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: `Session ${id}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    remoteUrl: "https://github.com/acme/app.git",
    ...overrides,
  };
}

function setAgentRunning(id: string, running: boolean) {
  useSessionStore.setState((state) => {
    const next = new Set(state.activeRunnerSessions);
    if (running) next.add(id);
    else next.delete(id);
    return { activeRunnerSessions: next };
  });
}

function setCard(id: string, card: PrCardState) {
  usePrStore.setState((state) => ({
    cardBySession: { ...state.cardBySession, [id]: card },
  }));
}

function setStatus(id: string, status: PrStatusSummary) {
  usePrStore.setState((state) => ({
    statusBySession: { ...state.statusBySession, [id]: status },
  }));
}

describe("useAttentionNotifications", () => {
  it("does not fire on initial mount for a session that is already in an attention state", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));
    settle();
    expect(notify).not.toHaveBeenCalled();
  });

  it("fires when a session transitions from agent-running to idle", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));
    expect(notify).not.toHaveBeenCalled();

    act(() => setAgentRunning("s1", false));
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Waiting for your input", {
      sessionName: "Session s1",
      repoLabel: "acme/app",
    });
  });

  /**
   * The docs/235 regression. The CLI drains its background-task list ~1ms before
   * the self-wake that starts the next turn, so the session reads as "idle, needs
   * you" for a single frame. Firing the chime there tells the user their agent
   * stopped while it is visibly working.
   */
  it("does not fire when the attention state reverts inside the settle window", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    useSessionStore.setState({ backgroundTaskSessions: new Map([["s1", ["npm test"]]]) });

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    // Task list drains — neither running nor holding tasks for one frame.
    act(() => { useSessionStore.setState({ backgroundTaskSessions: new Map<string, string[]>() }); });
    // The self-wake lands a moment later and the turn is running again.
    act(() => { vi.advanceTimersByTime(50); });
    act(() => setAgentRunning("s1", true));
    settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it("still fires once the reason outlives the settle window", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => setAgentRunning("s1", false));
    // Not yet — the window hasn't elapsed.
    act(() => { vi.advanceTimersByTime(500); });
    expect(notify).not.toHaveBeenCalled();

    settle();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("announces the reason the session settled on, not the one it started with", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    // Turn ends -> "Waiting for your input" starts settling...
    act(() => setAgentRunning("s1", false));
    // ...then CI failure arrives before the window elapses.
    act(() => {
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      });
    });
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("CI checks failed", expect.any(Object));
  });

  it("fires when a newly-created headless session finishes before the user views it", () => {
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      useSessionStore.setState({
        sessionId: "current",
        sessions: [session("current"), session("quick", { title: "Quick fix" })],
        activeRunnerSessions: new Set(["quick"]),
      });
    });
    settle();
    expect(notify).not.toHaveBeenCalled();

    act(() => setAgentRunning("quick", false));
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Waiting for your input", {
      sessionName: "Quick fix",
      repoLabel: "acme/app",
    });
  });


  it("fires when CI failure arrives for an idle session", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      setAgentRunning("s1", false);
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      });
    });
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("CI checks failed", expect.any(Object));
  });

  it("stays silent when CI fails but auto-fix is enabled (a fix is coming)", () => {
    useSettingsStore.setState({ autoFixCi: true });
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      setAgentRunning("s1", false);
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      });
    });
    settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it("fires when the auto-fix loop exhausts its attempts", () => {
    useSettingsStore.setState({ autoFixCi: true });
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      setAgentRunning("s1", false);
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
        autoFix: { status: "exhausted", attemptCount: 3, maxAttempts: 3 },
      });
    });
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("CI fix failed after 3 attempts", expect.any(Object));
  });

  it("stays silent on a merge conflict when auto-resolve is enabled", () => {
    useSettingsStore.setState({ autoResolveConflicts: true });
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      setAgentRunning("s1", false);
      setStatus("s1", { prState: "open", mergeable: "conflicting" } as PrStatusSummary);
    });
    settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent on an idle clean PR when auto-merge owns the merge", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => {
      setAgentRunning("s1", false);
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        autoMerge: { enabled: true, mergeMethod: "squash" },
      });
    });
    settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not fire again when reason changes from one non-null value to another", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    // First transition: running -> idle (Waiting for your input).
    act(() => setAgentRunning("s1", false));
    settle();
    expect(notify).toHaveBeenCalledTimes(1);

    // Now CI failure arrives — reason changes "Waiting" -> "CI checks failed".
    // This is not a null -> reason transition, so should not fire again.
    act(() => {
      setCard("s1", {
        cardId: "c1",
        phase: "open",
        checks: { state: "failure", total: 3, passed: 1, failed: 2, pending: 0 },
      });
    });
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ignores archived sessions", () => {
    useSessionStore.setState({ sessions: [session("s1", { archived: true })] });
    setAgentRunning("s1", true);
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));
    act(() => setAgentRunning("s1", false));
    settle();
    expect(notify).not.toHaveBeenCalled();
  });

  it("drops a settling notification when the session is archived before it fires", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => setAgentRunning("s1", false));
    act(() => { useSessionStore.setState({ sessions: [session("s1", { archived: true })] }); });
    settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it("fires for the right session when only one transitions", () => {
    useSessionStore.setState({
      sessions: [session("s1", { title: "First" }), session("s2", { title: "Second" })],
    });
    setAgentRunning("s1", true);
    setAgentRunning("s2", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => setAgentRunning("s2", false));
    settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Waiting for your input",
      expect.objectContaining({ sessionName: "Second" }),
    );
  });

  it("does not fire when transitioning back to attention after the user resumes", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    // First transition: idle (Waiting).
    act(() => setAgentRunning("s1", false));
    settle();
    expect(notify).toHaveBeenCalledTimes(1);

    // User sends a new message — agent runs again. Reason -> null.
    act(() => setAgentRunning("s1", true));
    settle();
    expect(notify).toHaveBeenCalledTimes(1);

    // Agent finishes again. null -> "Waiting", so we should fire a second time.
    act(() => setAgentRunning("s1", false));
    settle();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("omits repoLabel for sessions without a remoteUrl", () => {
    useSessionStore.setState({
      sessions: [session("s1", { remoteUrl: "" })],
    });
    setAgentRunning("s1", true);
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    act(() => setAgentRunning("s1", false));
    settle();

    expect(notify).toHaveBeenCalledWith(
      "Waiting for your input",
      { sessionName: "Session s1", repoLabel: undefined },
    );
  });
});
