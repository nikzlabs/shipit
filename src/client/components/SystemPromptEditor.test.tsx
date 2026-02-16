import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SystemPromptEditor } from "./SystemPromptEditor.js";

afterEach(cleanup);

describe("SystemPromptEditor", () => {
  it("renders the dialog with correct role and aria-label", () => {
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Project Instructions");
  });

  it("renders the header title", () => {
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Project Instructions")).toBeInTheDocument();
  });

  it("renders empty state with placeholder", () => {
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    const textarea = screen.getByTestId("system-prompt-textarea");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder");
  });

  it("renders with existing prompt content", () => {
    render(
      <SystemPromptEditor
        initialContent="Always use TypeScript."
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByTestId("system-prompt-textarea")).toHaveValue("Always use TypeScript.");
  });

  it("displays character count", () => {
    render(
      <SystemPromptEditor
        initialContent="Hello"
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("5 / 50,000")).toBeInTheDocument();
  });

  it("updates character count as user types", () => {
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    const textarea = screen.getByTestId("system-prompt-textarea");
    fireEvent.change(textarea, { target: { value: "Use strict mode." } });
    expect(screen.getByText("16 / 50,000")).toBeInTheDocument();
  });

  it("calls onSave with content when Save is clicked", () => {
    const onSave = vi.fn();
    render(
      <SystemPromptEditor
        initialContent="Original"
        onSave={onSave}
        onClose={() => {}}
      />
    );
    const textarea = screen.getByTestId("system-prompt-textarea");
    fireEvent.change(textarea, { target: { value: "Updated content" } });
    fireEvent.click(screen.getByTestId("system-prompt-save"));
    expect(onSave).toHaveBeenCalledWith("Updated content");
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when close button (x) is clicked", () => {
    const onClose = vi.fn();
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByTestId("system-prompt-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal content", () => {
    const onClose = vi.fn();
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByText("Project Instructions"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables Save button when content exceeds 50,000 characters", () => {
    render(
      <SystemPromptEditor
        initialContent={"x".repeat(50_001)}
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    const saveBtn = screen.getByTestId("system-prompt-save");
    expect(saveBtn).toBeDisabled();
  });

  it("shows CLAUDE.md note", () => {
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <SystemPromptEditor
        initialContent=""
        onSave={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onSave when Ctrl+Enter is pressed", () => {
    const onSave = vi.fn();
    render(
      <SystemPromptEditor
        initialContent="Test content"
        onSave={onSave}
        onClose={() => {}}
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("Test content");
  });

  it("saves with empty string when content is cleared", () => {
    const onSave = vi.fn();
    render(
      <SystemPromptEditor
        initialContent="Existing content"
        onSave={onSave}
        onClose={() => {}}
      />
    );
    const textarea = screen.getByTestId("system-prompt-textarea");
    fireEvent.change(textarea, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("system-prompt-save"));
    expect(onSave).toHaveBeenCalledWith("");
  });
});
