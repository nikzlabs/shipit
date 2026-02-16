import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GitIdentityOverlay } from "./GitIdentityOverlay.js";

afterEach(cleanup);

describe("GitIdentityOverlay", () => {
  it("renders the dialog with heading", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    expect(screen.getByText("Git Identity Required")).toBeInTheDocument();
  });

  it("renders name and email input fields", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText("Your Name")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
  });

  it("renders a Save button", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("Save button is disabled when both inputs are empty", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("Save button is disabled when only name is filled", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("Save button is disabled when only email is filled", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("Save button is enabled when both inputs have values", () => {
    render(<GitIdentityOverlay onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
    expect(screen.getByText("Save")).not.toBeDisabled();
  });

  it("calls onSubmit with trimmed name and email when Save is clicked", () => {
    const onSubmit = vi.fn();
    render(<GitIdentityOverlay onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "  Test User  " } });
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "  test@example.com  " } });
    fireEvent.click(screen.getByText("Save"));

    expect(onSubmit).toHaveBeenCalledWith("Test User", "test@example.com");
  });

  it("calls onSubmit when Enter is pressed with both fields filled", () => {
    const onSubmit = vi.fn();
    render(<GitIdentityOverlay onSubmit={onSubmit} />);

    const nameInput = screen.getByPlaceholderText("Your Name");
    const emailInput = screen.getByPlaceholderText("you@example.com");
    fireEvent.change(nameInput, { target: { value: "Test" } });
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("Test", "test@example.com");
  });

  it("does not call onSubmit when Enter is pressed with empty fields", () => {
    const onSubmit = vi.fn();
    render(<GitIdentityOverlay onSubmit={onSubmit} />);

    const nameInput = screen.getByPlaceholderText("Your Name");
    fireEvent.keyDown(nameInput, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not dismiss when clicking the backdrop", () => {
    const onSubmit = vi.fn();
    const { container } = render(<GitIdentityOverlay onSubmit={onSubmit} />);
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    // Overlay should still be visible (no dismiss handler)
    expect(screen.getByText("Git Identity Required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
