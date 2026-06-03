import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { FileEditModal } from "./FileEditModal.js";

let editorChange: (() => void) | null = null;
let editorValue = "";

vi.mock("monaco-editor", () => ({
  editor: {
    create: (_el: HTMLElement, opts: { value: string }) => {
      editorValue = opts.value;
      return {
        dispose: vi.fn(),
        focus: vi.fn(),
        getValue: () => editorValue,
        onDidChangeModelContent: (cb: () => void) => {
          editorChange = cb;
          return { dispose: vi.fn() };
        },
      };
    },
  },
}));

afterEach(() => {
  cleanup();
  editorChange = null;
  editorValue = "";
});

describe("FileEditModal", () => {
  it("renders loading state", () => {
    render(
      <FileEditModal
        filePath="src/app.ts"
        content=""
        originalContent=""
        loading
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("disables save when content is unchanged", async () => {
    render(
      <FileEditModal
        filePath="src/app.ts"
        content="const x = 1;"
        originalContent="const x = 1;"
        loading={false}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId("file-edit-monaco")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("calls onChange when Monaco content changes", async () => {
    const onChange = vi.fn();
    render(
      <FileEditModal
        filePath="src/app.ts"
        content="old"
        originalContent="old"
        loading={false}
        saving={false}
        error={null}
        onChange={onChange}
        onSave={async () => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(editorChange).not.toBeNull());
    editorValue = "new";
    editorChange?.();
    expect(onChange).toHaveBeenCalledWith("new");
  });

  it("saves dirty content", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <FileEditModal
        filePath="src/app.ts"
        content="new"
        originalContent="old"
        loading={false}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  });

  it("asks before discarding dirty content", () => {
    const onClose = vi.fn();
    render(
      <FileEditModal
        filePath="src/app.ts"
        content="new"
        originalContent="old"
        loading={false}
        saving={false}
        error={null}
        onChange={() => {}}
        onSave={async () => {}}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows save errors while keeping save retry enabled", () => {
    render(
      <FileEditModal
        filePath="src/app.ts"
        content="new"
        originalContent="old"
        loading={false}
        saving={false}
        error="Failed to save file"
        onChange={() => {}}
        onSave={async () => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to save file");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
