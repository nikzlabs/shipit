import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionItem } from "./SessionItem.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { SessionInfo } from "../../../server/shared/types.js";

afterEach(cleanup);

const session = (keepPreviewRunning = false): SessionInfo => ({
  id: "s1", title: "Preview session", createdAt: "2024-01-01", lastUsedAt: "2024-01-01",
  remoteUrl: "", ...(keepPreviewRunning ? { keepPreviewRunning: true } : {}),
});

describe("SessionItem keep-preview action", () => {
  it("calls the toggle callback and shows a checkmark only when enabled", async () => {
    const toggle = vi.fn().mockResolvedValue(undefined);
    useSessionStore.setState({ setKeepPreviewRunning: toggle });
    const user = userEvent.setup();
    const { rerender } = render(
      <SessionItem session={session()} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />,
    );
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    const action = screen.getByText("Keep preview running").closest("div");
    expect(action?.querySelector("svg")).toBeNull();
    await user.click(screen.getByText("Keep preview running"));
    expect(toggle).toHaveBeenCalledWith("s1", true);

    rerender(<SessionItem session={session(true)} isCurrent onResume={vi.fn()} overflowMenuPortaled={false} />);
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByText("Keep preview running").closest("div")?.querySelector("svg")).not.toBeNull();
  });
});
