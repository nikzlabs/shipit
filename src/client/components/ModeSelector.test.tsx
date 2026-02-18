import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ModeSelector } from "./ModeSelector.js";

afterEach(cleanup);

describe("ModeSelector", () => {
  it("renders three mode buttons", () => {
    render(<ModeSelector mode="auto" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("mode-auto")).toBeInTheDocument();
    expect(screen.getByTestId("mode-plan")).toBeInTheDocument();
    expect(screen.getByTestId("mode-normal")).toBeInTheDocument();
  });

  it("marks the active mode with aria-pressed", () => {
    render(<ModeSelector mode="plan" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("mode-auto")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("mode-plan")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mode-normal")).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onChange when a mode is clicked", () => {
    const onChange = vi.fn();
    render(<ModeSelector mode="auto" onChange={onChange} disabled={false} />);
    fireEvent.click(screen.getByTestId("mode-plan"));
    expect(onChange).toHaveBeenCalledWith("plan");
  });

  it("shows 'Read-only' badge when plan mode is active", () => {
    render(<ModeSelector mode="plan" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("mode-badge")).toHaveTextContent("Read-only");
  });

  it("shows 'Supervised' badge when normal mode is active", () => {
    render(<ModeSelector mode="normal" onChange={vi.fn()} disabled={false} />);
    expect(screen.getByTestId("mode-badge")).toHaveTextContent("Supervised");
  });

  it("does not show a badge when auto mode is active", () => {
    render(<ModeSelector mode="auto" onChange={vi.fn()} disabled={false} />);
    expect(screen.queryByTestId("mode-badge")).not.toBeInTheDocument();
  });

  it("disables all buttons when disabled prop is true", () => {
    render(<ModeSelector mode="auto" onChange={vi.fn()} disabled={true} />);
    expect(screen.getByTestId("mode-auto")).toBeDisabled();
    expect(screen.getByTestId("mode-plan")).toBeDisabled();
    expect(screen.getByTestId("mode-normal")).toBeDisabled();
  });

  it("does not call onChange when disabled", () => {
    const onChange = vi.fn();
    render(<ModeSelector mode="auto" onChange={onChange} disabled={true} />);
    fireEvent.click(screen.getByTestId("mode-plan"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
