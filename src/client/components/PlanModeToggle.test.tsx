import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanModeToggle } from "./PlanModeToggle.js";

afterEach(cleanup);

describe("PlanModeToggle", () => {
  it("renders with auto mode label when mode is auto", () => {
    render(<PlanModeToggle mode="auto" onChange={vi.fn()} disabled={false} />);
    const toggle = screen.getByTestId("plan-mode-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-label", "Switch to plan mode");
  });

  it("renders with plan mode label when mode is plan", () => {
    render(<PlanModeToggle mode="plan" onChange={vi.fn()} disabled={false} />);
    const toggle = screen.getByTestId("plan-mode-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-label", "Switch to auto mode");
  });

  it("toggles from auto to plan on click", () => {
    const onChange = vi.fn();
    render(<PlanModeToggle mode="auto" onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByTestId("plan-mode-toggle"));
    expect(onChange).toHaveBeenCalledWith("plan");
  });

  it("toggles from plan to auto on click", () => {
    const onChange = vi.fn();
    render(<PlanModeToggle mode="plan" onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByTestId("plan-mode-toggle"));
    expect(onChange).toHaveBeenCalledWith("auto");
  });

  it("treats legacy normal mode as not-plan (toggles to plan)", () => {
    const onChange = vi.fn();
    render(<PlanModeToggle mode="normal" onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByTestId("plan-mode-toggle"));
    expect(onChange).toHaveBeenCalledWith("plan");
  });

  it("disables the button when disabled is true", () => {
    render(<PlanModeToggle mode="auto" onChange={vi.fn()} disabled={true} />);
    expect(screen.getByTestId("plan-mode-toggle")).toBeDisabled();
  });
});
