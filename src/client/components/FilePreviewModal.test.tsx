import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FilePreviewModal } from "./FilePreviewModal.js";

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

  it("renders code content with syntax highlighting", () => {
    const { container } = render(
      <FilePreviewModal filePath="hello.js" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    const codeEl = container.querySelector("code.hljs");
    expect(codeEl).not.toBeNull();
    expect(codeEl!.innerHTML).toBeTruthy();
  });

  it("renders code inside a pre element", () => {
    const { container } = render(
      <FilePreviewModal filePath="test.txt" content="plain text" fileType="code" onClose={() => {}} />
    );
    const preEl = container.querySelector("pre");
    expect(preEl).not.toBeNull();
  });

  it("applies syntax highlighting for TypeScript files", () => {
    const { container } = render(
      <FilePreviewModal
        filePath="src/app.ts"
        content="const greeting: string = 'hello';"
        fileType="code"
        onClose={() => {}}
      />
    );
    const codeEl = container.querySelector("code.hljs");
    const spans = codeEl!.querySelectorAll("span");
    expect(spans.length).toBeGreaterThan(0);
  });

  it("renders markdown content with prose styling", () => {
    const { container } = render(
      <FilePreviewModal
        filePath="README.md"
        content="# Hello World"
        fileType="markdown"
        onClose={() => {}}
      />
    );
    const prose = container.querySelector(".prose");
    expect(prose).not.toBeNull();
    expect(prose!.innerHTML).toContain("Hello World");
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
