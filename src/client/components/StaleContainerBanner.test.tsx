import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StaleContainerBanner } from "./StaleContainerBanner.js";
import { useSessionStore } from "../stores/session-store.js";

const post = vi.fn();

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

    fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/api/sessions/session%20one/agent/container/restart");
    });
    expect(screen.getByTestId("stale-container-banner")).toBeInTheDocument();
  });

  it("does not allow a restart during an active turn", () => {
    useSessionStore.getState().setContainerFreshness({
      state: "stale",
      workerBuildId: "old",
      orchestratorBuildId: "new",
    });
    useSessionStore.getState().setIsLoading(true);
    render(<StaleContainerBanner sessionId="s1" />);

    const button = screen.getByRole("button", { name: "Restart after turn" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(post).not.toHaveBeenCalled();
  });
});
