import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SendReviewDialog } from "./SendReviewDialog.js";

// The shared Dialog pushes a dummy history entry on open; stub it so jsdom's
// real history isn't mutated across tests (same reason as ui/dialog.test.tsx).
beforeEach(() => {
  vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  vi.spyOn(window.history, "back").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(overrides: Partial<Parameters<typeof SendReviewDialog>[0]> = {}) {
  const props = {
    open: true,
    commentCount: 3,
    target: "docs/241-spec-discipline/plan.md",
    note: "",
    onNoteChange: vi.fn(),
    onSend: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SendReviewDialog {...props} />);
  return props;
}

describe("SendReviewDialog", () => {
  it("shows the comment count and what the comments are on", () => {
    renderDialog();
    expect(screen.getByText(/3 comments on/)).toBeTruthy();
    expect(screen.getByText("docs/241-spec-discipline/plan.md")).toBeTruthy();
  });

  it("singularizes a lone comment", () => {
    renderDialog({ commentCount: 1 });
    expect(screen.getByText(/1 comment on/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send 1 comment$/ })).toBeTruthy();
  });

  // The whole point of the first version: no comment list, no per-comment
  // removal (requirements.md → Later versions). Guard it, so the dialog does
  // not quietly regrow one.
  it("does not list the comments", () => {
    renderDialog();
    expect(screen.queryByText(/Every new feature/)).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Send 3 comments")]),
    );
    expect(screen.queryByRole("button", { name: /remove|drop/i })).toBeNull();
  });

  it("reports typing in the note field", () => {
    const props = renderDialog();
    fireEvent.change(screen.getByLabelText(/Add a note for the agent/), {
      target: { value: "keep the structure" },
    });
    expect(props.onNoteChange).toHaveBeenCalledWith("keep the structure");
  });

  it("sends on the Send button, with the note left to the caller's state", () => {
    const props = renderDialog({ note: "keep the structure" });
    fireEvent.click(screen.getByRole("button", { name: /Send 3 comments/ }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("sends on ⌘⏎ inside the note field", () => {
    const props = renderDialog();
    fireEvent.keyDown(screen.getByLabelText(/Add a note for the agent/), {
      key: "Enter",
      metaKey: true,
    });
    expect(props.onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send on a plain Enter — that's a newline in the note", () => {
    const props = renderDialog();
    fireEvent.keyDown(screen.getByLabelText(/Add a note for the agent/), { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("closes without sending on Cancel", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByText("Send review")).toBeNull();
  });
});
