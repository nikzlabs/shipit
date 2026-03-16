import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilePreviewModal } from "./FilePreviewModal.js";

// Monaco editor uses dynamic import("monaco-editor") and won't work in jsdom.
// Mock the module so the CodeEditor sub-component renders a simple div.
vi.mock("monaco-editor", () => ({
  editor: {
    create: () => ({
      dispose: vi.fn(),
      onMouseDown: () => ({ dispose: vi.fn() }),
      updateOptions: vi.fn(),
      changeViewZones: vi.fn(),
      createDecorationsCollection: vi.fn(),
    }),
  },
}));

afterEach(cleanup);

describe("FilePreviewModal", () => {
  it("renders the file path in the header", () => {
    render(
      <FilePreviewModal filePath="src/index.ts" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("renders a close button", () => {
    const onClose = vi.fn();
    render(
      <FilePreviewModal filePath="test.txt" content="hello" fileType="code" onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows loading state when content is null", () => {
    render(
      <FilePreviewModal filePath="src/app.ts" content={null} fileType="code" onClose={() => {}} />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders code content in an editor container", () => {
    const { container } = render(
      <FilePreviewModal filePath="hello.js" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    // CodeEditor renders a div with h-full w-full for the Monaco editor mount point
    const editorDiv = container.querySelector(".h-full.w-full");
    expect(editorDiv).not.toBeNull();
  });

  it("renders markdown content via MarkdownSectionComments", () => {
    render(
      <FilePreviewModal
        filePath="README.md"
        content="# Hello World"
        fileType="markdown"
        onClose={() => {}}
      />
    );
    // MarkdownSectionComments renders the heading text
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("renders image content", () => {
    render(
      <FilePreviewModal
        filePath="photo.png"
        content="data:image/png;base64,abc123"
        fileType="image"
        onClose={() => {}}
      />
    );
    const img = screen.getByAltText("photo.png");
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("renders binary file message", () => {
    render(
      <FilePreviewModal
        filePath="data.bin"
        content="Binary file — cannot display."
        fileType="binary"
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Binary file — cannot display.")).toBeInTheDocument();
  });

  it("renders action buttons in header", () => {
    const onAction = vi.fn();
    render(
      <FilePreviewModal
        filePath="plan.md"
        content="# Plan"
        fileType="markdown"
        actions={[{ label: "Start Session", onClick: onAction, variant: "primary" }]}
        onClose={() => {}}
      />
    );
    const btn = screen.getByText("Start Session");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(
      <FilePreviewModal filePath="test.txt" content="hello" fileType="code" onClose={onClose} />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the file path as title attribute for truncation", () => {
    render(
      <FilePreviewModal
        filePath="very/long/path/to/some/deeply/nested/file.ts"
        content="code"
        fileType="code"
        onClose={() => {}}
      />
    );
    const pathEl = screen.getByTitle("very/long/path/to/some/deeply/nested/file.ts");
    expect(pathEl).toBeInTheDocument();
  });
});
