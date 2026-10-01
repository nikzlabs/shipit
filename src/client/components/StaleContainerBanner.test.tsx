import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StaleContainerBanner } from "./StaleContainerBanner.js";
import { useSessionStore } from "../stores/session-store.js";

const post = vi.fn();
const del = vi.fn();
const STALE = { state: "stale" as const, workerBuildId: "old", orchestratorBuildId: "new" };

vi.mock("../hooks/useApi.js", () => ({
  ApiError: class ApiError extends Error {},
  useApi: () => ({ post, del }),
}));

describe("StaleContainerBanner", () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    useSessionStore.getState().setSessionId(undefined);
    post.mockReset();
    del.mockReset();
  });

  afterEach(cleanup);

  it("renders only for a stale worker", () => {
    const { rerender } = render(<StaleContainerBanner sessionId="session one" />);
    expect(screen.queryByTestId("stale-container-banner")).not.toBeInTheDocument();

    useSessionStore.getState().setContainerFreshness({
      state: "stale",
      workerBuildId: "old",
      orchestratorBuildId: "new",
    });
    rerender(<StaleContainerBanner sessionId="session one" />);
    expect(screen.getByText("Update available for this session")).toBeInTheDocument();
  });

  it("uses the agent-only restart path and keeps the warning until fresh state arrives", async () => {
    post.mockResolvedValue({ ok: true, newContainerState: "running", error: null });
    useSessionStore.getState().setContainerFreshness({
      state: "stale",
      workerBuildId: "old",
      orchestratorBuildId: "new",
    });
    render(<StaleContainerBanner sessionId="session one" />);

    fireEvent.click(screen.getByRole("button", { name: "Restart agent container" }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/api/sessions/session%20one/agent/container/restart");
    });
    expect(screen.getByTestId("stale-container-banner")).toBeInTheDocument();
  });

  it("schedules the restart during an active turn, without the restart overlay", async () => {
    post.mockResolvedValue({ ok: true, scheduled: true });
    useSessionStore.getState().setSessionId("s1");
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Restart after turn" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel restart" })).toBeEnabled();
    });
    expect(screen.queryByRole("button", { name: "Restart after turn" })).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledWith("/api/sessions/s1/agent/container/restart", { afterTurn: true });
    expect(useSessionStore.getState().rescueState).toBeNull();
    expect(screen.getByText(/It restarts when this turn ends/)).toBeInTheDocument();
  });

  it("cancels a scheduled restart, and offers the restart again (req 10)", async () => {
    del.mockResolvedValue({ ok: true });
    useSessionStore.getState().setSessionId("s1");
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Restart after turn" })).toBeEnabled();
    });
    expect(del).toHaveBeenCalledWith("/api/sessions/s1/agent/container/restart");
    expect(post).not.toHaveBeenCalled();
    expect(useSessionStore.getState().restartScheduled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel restart" })).not.toBeInTheDocument();
  });

  it("keeps the restart scheduled when the cancel fails", async () => {
    del.mockRejectedValue(new Error("network down"));
    useSessionStore.getState().setSessionId("s1");
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    await waitFor(() => expect(del).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel restart" })).toBeEnabled());
    expect(useSessionStore.getState().restartScheduled).toBe(true);
  });

  it("does not change another session when the cancel answer arrives after a session switch", async () => {
    let answer: (value: unknown) => void = () => {};
    del.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    useSessionStore.getState().setSessionId("s1");
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    // The session the user switched to has its own scheduled restart.
    useSessionStore.getState().setSessionId("s2");
    answer({ ok: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel restart" })).toBeEnabled());
    expect(useSessionStore.getState().restartScheduled).toBe(true);
  });

  it("a late cancel answer does not hide a restart that was scheduled after it", async () => {
    let answer: (value: unknown) => void = () => {};
    del.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    post.mockResolvedValue({ ok: true, scheduled: true });
    useSessionStore.getState().setSessionId("s1");
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    useSessionStore.getState().setIsLoading(true);
    const first = render(<StaleContainerBanner sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel restart" }));

    // The user leaves and comes back: a new banner, and the server's state from the attach.
    first.unmount();
    useSessionStore.getState().setRestartScheduled(false);
    render(<StaleContainerBanner sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Restart after turn" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel restart" })).toBeEnabled());

    answer({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionStore.getState().restartScheduled).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel restart" })).toBeInTheDocument();
  });

  it("restarts at once when the turn ended before the request arrived", async () => {
    post.mockResolvedValue({ ok: true, newContainerState: "running", error: null });
    const reconnect = vi.fn();
    window.addEventListener("shipit:reconnect-ws", reconnect);
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Restart after turn" }));

    await waitFor(() => expect(reconnect).toHaveBeenCalled());
    window.removeEventListener("shipit:reconnect-ws", reconnect);
    expect(useSessionStore.getState().restartScheduled).toBe(false);
  });

  it("says so when a scheduled restart still waits after the turn, and offers the restart now", () => {
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    render(<StaleContainerBanner sessionId="s1" />);

    expect(screen.getByText(/The scheduled restart waits/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart agent container" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel restart" })).toBeEnabled();
  });

  it("does not mark another session when the answer arrives after a session switch", async () => {
    let answer: (value: unknown) => void = () => {};
    post.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Restart after turn" }));

    useSessionStore.getState().setSessionId("s2");
    answer({ ok: true, scheduled: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "Restart after turn" })).toBeEnabled());
    expect(useSessionStore.getState().restartScheduled).toBe(false);
  });
});
