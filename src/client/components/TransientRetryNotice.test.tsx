import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { TransientRetryNotice, waitText } from "./TransientRetryNotice.js";
import { useSessionStore } from "../stores/session-store.js";
import type { SessionListRow } from "../../server/shared/types.js";

const row = (over: Partial<SessionListRow> = {}): SessionListRow =>
  ({ id: "s1", title: "A session", createdAt: "", lastUsedAt: "", remoteUrl: "", ...over }) as SessionListRow;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useSessionStore.getState().reset();
});

describe("TransientRetryNotice (docs/342-transient-provider-retry reqs 9-11)", () => {
  it("shows nothing while no continuation waits", () => {
    useSessionStore.getState().setSessions([row()]);
    render(<TransientRetryNotice sessionId="s1" />);
    expect(screen.queryByTestId("transient-retry-notice")).toBeNull();
  });

  it("shows when the continuation runs, counting down", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-13T10:00:00.000Z") });
    useSessionStore.getState().setSessions([row({ transientRetryAt: "2026-11-13T10:00:30.000Z" })]);
    render(<TransientRetryNotice sessionId="s1" />);
    expect(screen.getByTestId("transient-retry-notice")).toHaveTextContent("continue in 30 s");

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId("transient-retry-notice")).toHaveTextContent("continue in 20 s");
  });

  it("cancels by session id, and goes once the row no longer waits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ cancelled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useSessionStore.getState().setSessions([row({ transientRetryAt: new Date(Date.now() + 120_000).toISOString() })]);
    render(<TransientRetryNotice sessionId="s1" />);

    fireEvent.click(screen.getByTestId("transient-retry-notice-cancel"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/agent/transient-retry/cancel");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");

    // The server's session_list then carries the row without it.
    act(() => { useSessionStore.getState().setSessions([row()]); });
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
