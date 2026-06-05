import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useAttentionNotifications } from "./useAttentionNotifications.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(() => {
  cleanup();
  useSessionStore.setState({
    sessions: [],
    activeRunnerSessions: new Set<string>(),
  });
  usePrStore.setState({ cardBySession: {}, statusBySession: {} });
  useSettingsStore.setState({ autoFixCi: false, autoResolveConflicts: false });
});

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
    expect(notify).not.toHaveBeenCalled();
  });

  it("fires when a session transitions from agent-running to idle", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));
    expect(notify).not.toHaveBeenCalled();

    act(() => setAgentRunning("s1", false));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Waiting for your input", {
      sessionName: "Session s1",
      repoLabel: "acme/app",
    });
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
    expect(notify).not.toHaveBeenCalled();

    act(() => setAgentRunning("quick", false));

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

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not fire again when reason changes from one non-null value to another", () => {
    useSessionStore.setState({ sessions: [session("s1")] });
    setAgentRunning("s1", true);

    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));

    // First transition: running -> idle (Waiting for your input).
    act(() => setAgentRunning("s1", false));
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

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ignores archived sessions", () => {
    useSessionStore.setState({ sessions: [session("s1", { archived: true })] });
    setAgentRunning("s1", true);
    const notify = vi.fn();
    renderHook(() => useAttentionNotifications(notify));
    act(() => setAgentRunning("s1", false));
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
    expect(notify).toHaveBeenCalledTimes(1);

    // User sends a new message — agent runs again. Reason -> null.
    act(() => setAgentRunning("s1", true));
    expect(notify).toHaveBeenCalledTimes(1);

    // Agent finishes again. null -> "Waiting", so we should fire a second time.
    act(() => setAgentRunning("s1", false));
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

    expect(notify).toHaveBeenCalledWith(
      "Waiting for your input",
      { sessionName: "Session s1", repoLabel: undefined },
    );
  });
});
