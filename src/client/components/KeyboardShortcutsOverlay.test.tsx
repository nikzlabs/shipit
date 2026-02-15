import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { KeyboardShortcutsOverlay } from "./KeyboardShortcutsOverlay.js";

afterEach(cleanup);

describe("KeyboardShortcutsOverlay", () => {
  it("renders the dialog with keyboard shortcuts title", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
  });

  it("has role=dialog for accessibility", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("has an accessible label", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Keyboard shortcuts");
  });

  // --- Shortcut groups ---
  it("renders General group", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders Chat group", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("renders Search group", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Search")).toBeInTheDocument();
  });

  // --- Shortcut entries ---
  it("shows toggle help overlay shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Toggle this help overlay")).toBeInTheDocument();
  });

  it("shows send message shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Send message")).toBeInTheDocument();
  });

  it("shows toggle search bar shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Toggle search bar")).toBeInTheDocument();
  });

  it("shows next search match shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Next search match")).toBeInTheDocument();
  });

  it("shows new line shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("New line in message")).toBeInTheDocument();
  });

  // --- Closing behavior ---
  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when ? is pressed", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: "?" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    // Click the backdrop (the outer div with role=dialog)
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByText("Keyboard Shortcuts"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the Esc button is clicked", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // --- Key rendering ---
  it("renders kbd elements for shortcut keys", () => {
    const { container } = render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });

  // --- Cleanup ---
  it("removes keydown listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<KeyboardShortcutsOverlay onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
