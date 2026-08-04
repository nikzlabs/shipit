import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSessionsPanel } from "./MobileSessionsPanel.js";

afterEach(cleanup);

describe("MobileSessionsPanel", () => {
  it("keeps the sessions content mounted while the drawer is closed", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <MobileSessionsPanel open onClose={onClose}>
        <div>Session list</div>
      </MobileSessionsPanel>,
    );

    const sessions = screen.getByText("Session list");
    const drawer = screen.getByRole("dialog");
    drawer.scrollTop = 180;
    fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <MobileSessionsPanel open={false} onClose={onClose}>
        <div>Session list</div>
      </MobileSessionsPanel>,
    );

    expect(screen.getByText("Session list")).toBe(sessions);
    expect(drawer).toHaveClass("hidden");
    expect(drawer.scrollTop).toBe(180);
  });
});
