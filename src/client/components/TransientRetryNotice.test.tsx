import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { TransientRetryNotice, waitText } from "./TransientRetryNotice.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionListRow } from "../../server/shared/types.js";

const row = (over: Partial<SessionListRow> = {}): SessionListRow =>
  ({ id: "s1", title: "A session", createdAt: "", lastUsedAt: "", remoteUrl: "", ...over }) as SessionListRow;

// As App reads it: the displayed session's row from the sidebar list, else All sessions.
function Harness() {
  const retryAt = useSessionStore((s) =>
    (s.sessions.find((r) => r.id === "s1") ?? s.allSessions.find((r) => r.id === "s1"))?.transientRetryAt);
  return <TransientRetryNotice sessionId="s1" rowRetryAt={retryAt} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useSessionStore.getState().reset();
  useSessionStore.setState({ sessions: [], allSessions: [], transientRetries: {} });
});

describe("TransientRetryNotice (docs/342-transient-provider-retry reqs 9-11)", () => {
  it("shows nothing while no continuation waits", () => {
    useSessionStore.getState().setSessions([row()]);
    render(<Harness />);
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();
  });

  it("shows when the continuation runs, counting down", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-13T10:00:00.000Z") });
    useSessionStore.getState().setSessions([row({ transientRetryAt: "2026-11-13T10:00:30.000Z" })]);
    render(<Harness />);
    expect(screen.getByTestId("transient-retry-notice")).toHaveTextContent("continue in 30 s");

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId("transient-retry-notice")).toHaveTextContent("continue in 20 s");
  });

  it("cancels by session id, and goes once the row no longer waits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useSessionStore.getState().setSessions([row({ transientRetryAt: new Date(Date.now() + 120_000).toISOString() })]);
    render(<Harness />);

    fireEvent.click(screen.getByTestId("transient-retry-notice-cancel"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/agent/transient-retry/cancel");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");

    // Gone on the answer, without waiting for the broadcast.
    await waitFor(() => expect(screen.queryByTestId("transient-retry-notice")).toBeNull());
  });

  it("keeps the event's answer over an older row that arrives later", () => {
    useSessionStore.getState().setTransientRetryAt("s1", undefined);
    // An All-sessions fetch that started before the cancel lands after it.
    useSessionStore.setState({ allSessions: [row({ transientRetryAt: new Date(Date.now() + 30_000).toISOString() })] });
    render(<Harness />);
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();
  });

  it("lets a later session list win, so a missed event cannot stick", () => {
    useSessionStore.getState().setTransientRetryAt("s1", undefined);
    render(<Harness />);
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();

    // After a reconnect: the list says a wait runs, and the old event value must not hide it.
    act(() => {
      const store = useSessionStore.getState();
      store.setSessions([row({ transientRetryAt: new Date(Date.now() + 30_000).toISOString() })]);
      store.forgetTransientRetries(["s1"]);
    });
    expect(screen.getByTestId("transient-retry-notice")).toBeInTheDocument();
  });

  it("follows the server's event for a session past the sidebar's cap", () => {
    useSessionStore.setState({ allSessions: [row()] });
    render(<Harness />);
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();

    act(() => { useSessionStore.getState().setTransientRetryAt("s1", new Date(Date.now() + 30_000).toISOString()); });
    expect(screen.getByTestId("transient-retry-notice")).toBeInTheDocument();

    act(() => { useSessionStore.getState().setTransientRetryAt("s1", undefined); });
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();
  });

  it.each([
    [30_000, "in 30 s"],
    [1_500, "in 2 s"],
    [120_000, "in 2 min"],
    [125_000, "in 2 min 5 s"],
    [0, "now"],
  ])("words %i ms as %s", (ms, text) => {
    expect(waitText(ms)).toBe(text);
  });
});
