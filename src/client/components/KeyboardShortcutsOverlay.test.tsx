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

  it("has an accessible name from its title", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Keyboard Shortcuts");
  });

  // --- Shortcut groups ---
  it("renders General group", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders Sessions group", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
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
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("shows new session shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("New session")).toBeInTheDocument();
  });

  it("shows send message shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Send message")).toBeInTheDocument();
  });

  it("shows chat search shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Search the chat (when chat input is focused)")).toBeInTheDocument();
  });

  it("shows quick capture shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("Quick capture")).toBeInTheDocument();
  });

  it("renders an Edit button when onEdit is provided", () => {
    const onEdit = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("shows new line shortcut", () => {
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    expect(screen.getByText("New line in message")).toBeInTheDocument();
  });

  // --- Closing behavior ---
  // Escape, the backdrop, and the corner close button now come from the shared
  // Dialog (Radix) and are exercised in ui/dialog.test.tsx. Here we cover the
  // two app-specific toggles this component still owns, plus the close button.
  it("calls onClose when ? is pressed", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: "?" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Ctrl+/ is pressed", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cmd+/ is pressed", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByText("Keyboard Shortcuts"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsOverlay onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // --- Key rendering ---
  it("renders kbd elements for shortcut keys", () => {
    // The shared Dialog renders content in a portal (document.body), not inside
    // the render container, so query the document.
    render(<KeyboardShortcutsOverlay onClose={vi.fn()} />);
    const kbds = document.body.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });

  // --- Cleanup ---
  it("removes keydown listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<KeyboardShortcutsOverlay onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: "?" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
