import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StaleContainerBanner } from "./StaleContainerBanner.js";
import { useSessionStore } from "../stores/session-store.js";

const post = vi.fn();
const STALE = { state: "stale" as const, workerBuildId: "old", orchestratorBuildId: "new" };

vi.mock("../hooks/useApi.js", () => ({
  ApiError: class ApiError extends Error {},
  useApi: () => ({ post }),
}));

describe("StaleContainerBanner", () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    post.mockReset();
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
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Restart after turn" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Restart scheduled" })).toBeDisabled();
    });
    expect(post).toHaveBeenCalledWith("/api/sessions/s1/agent/container/restart", { afterTurn: true });
    expect(useSessionStore.getState().rescueState).toBeNull();
    expect(screen.getByText(/It restarts when this turn ends/)).toBeInTheDocument();
  });

  it("shows a restart that the server reports as scheduled, and sends no second request", () => {
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Restart scheduled" }));
    expect(post).not.toHaveBeenCalled();
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

  it("offers the restart again when a scheduled one still waits after the turn", () => {
    useSessionStore.getState().setContainerFreshness(STALE);
    useSessionStore.getState().setRestartScheduled(true);
    render(<StaleContainerBanner sessionId="s1" />);

    expect(screen.getByRole("button", { name: "Restart agent container" })).toBeEnabled();
  });
});
