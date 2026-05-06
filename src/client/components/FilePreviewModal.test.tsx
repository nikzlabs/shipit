import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilePreviewModal } from "./FilePreviewModal.js";
import { useFileReviewStore } from "../stores/file-review-store.js";
import { useSessionStore } from "../stores/session-store.js";

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
    render(
      <FilePreviewModal filePath="hello.js" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    // CodeEditor renders a div with h-full w-full for the Monaco editor mount point
    // Content is portaled by Radix Dialog, so query the full document
    const editorDiv = document.querySelector(".h-full.w-full");
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

  it("closes on Escape key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <FilePreviewModal filePath="test.txt" content="hello" fileType="code" onClose={onClose} />
    );
    await user.keyboard("{Escape}");
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

  it("renders the AI Review streaming progress panel while a run is in flight", () => {
    // Seed a session and a draft so the modal recognizes (sessionId, filePath).
    useSessionStore.setState({ sessionId: "s1" });
    useFileReviewStore.setState({
      draftByKey: {
        "s1::plan.md": {
          id: "draft-1",
          sessionId: "s1",
          filePath: "plan.md",
          fileType: "markdown",
          status: "draft",
          comments: [],
          docSnapshotHash: "h",
          sectionHeadings: [],
          createdAt: "x",
          updatedAt: "x",
        },
      },
      historyByKey: {},
      aiLoadingByKey: { "s1::plan.md": true },
      aiProgressByKey: { "s1::plan.md": "[{\"sectionHeading\":\"## A\"…" },
      loadingByKey: {},
    });

    render(
      <FilePreviewModal
        filePath="plan.md"
        content="## A\nbody"
        fileType="markdown"
        onClose={() => {}}
      />
    );

    const panel = screen.getByRole("status", { name: /AI Review in progress/i });
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toContain("sectionHeading");
  });

  it("hides the streaming panel when AI Review is not loading", () => {
    useSessionStore.setState({ sessionId: "s1" });
    useFileReviewStore.setState({
      draftByKey: {},
      historyByKey: {},
      aiLoadingByKey: {},
      aiProgressByKey: {},
      loadingByKey: {},
    });

    render(
      <FilePreviewModal filePath="plan.md" content="## A" fileType="markdown" onClose={() => {}} />
    );

    expect(screen.queryByRole("status", { name: /AI Review in progress/i })).toBeNull();
  });
});
