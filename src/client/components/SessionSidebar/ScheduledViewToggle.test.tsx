import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduledViewToggle } from "./ScheduledViewToggle.js";

afterEach(cleanup);

const control = () => screen.getByRole("button");

describe("ScheduledViewToggle", () => {
  it("announces the view it switches to, and reads as pressed in the Scheduled view", () => {
    const { rerender } = render(<ScheduledViewToggle active={false} onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-label")).toBe("Show scheduled runs");
    expect(control().getAttribute("aria-pressed")).toBe("false");

    rerender(<ScheduledViewToggle active onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-label")).toBe("Show all sessions");
    expect(control().getAttribute("aria-pressed")).toBe("true");
  });

  it("carries a warning mark, beside the glyph and in its name, while a schedule could not start", () => {
    const { rerender } = render(<ScheduledViewToggle active={false} onToggle={vi.fn()} />);
    expect(screen.queryByTestId("scheduled-view-warning")).toBeNull();

    rerender(<ScheduledViewToggle active={false} failedCount={1} onToggle={vi.fn()} />);
    expect(screen.getByTestId("scheduled-view-warning")).toBeTruthy();
    expect(control().getAttribute("aria-label")).toBe("Show scheduled runs (a schedule could not start)");

    rerender(<ScheduledViewToggle active failedCount={2} onToggle={vi.fn()} />);
    expect(control().getAttribute("aria-label")).toBe("Show all sessions (2 schedules could not start)");
  });

  it("calls back on click", async () => {
    const onToggle = vi.fn();
    render(<ScheduledViewToggle active={false} onToggle={onToggle} />);
    await userEvent.click(control());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
