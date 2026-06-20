import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RewindPoint } from "./RewindPoint.js";

afterEach(cleanup);

function renderPoint(props: Partial<React.ComponentProps<typeof RewindPoint>> = {}) {
  return render(
    <RewindPoint
      gapPosition={2}
      defaultSessionName="Parent session"
      onRewind={vi.fn()}
      onRequestPreview={vi.fn()}
      {...props}
    />,
  );
}

describe("RewindPoint", () => {
  // SHI-182: a running turn must not block fork. Fork spins off a new session
  // from a committed SHA and doesn't mutate this one, so the affordance stays
  // live (and presents as fork-only) while the agent works.
  it("keeps the fork affordance enabled while a turn is running", () => {
    renderPoint({ turnRunning: true });
    const button = screen.getByRole("button", { name: "Fork as new session" });
    expect(button).not.toBeDisabled();
  });

  it("offers the full rewind menu when idle", () => {
    renderPoint();
    expect(screen.getByRole("button", { name: "Rewind options" })).not.toBeDisabled();
  });

  // The `disabled` prop is the genuine hard-off (no current source today, but
  // it must still fully gate the control and surface the wait tooltip).
  it("fully disables the control when disabled", () => {
    renderPoint({ disabled: true, turnRunning: true });
    const button = screen.getByRole("button", { name: "Fork as new session" });
    expect(button).toBeDisabled();
    expect(button.title).toBe("Wait for the current turn to finish");
  });

  it("labels the current-state handle as a current-state fork", () => {
    renderPoint({ currentState: true });
    expect(screen.getByRole("button", { name: "Fork current state" })).not.toBeDisabled();
  });
});
