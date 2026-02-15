import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileContentViewer } from "./FileContentViewer.js";

afterEach(cleanup);

describe("FileContentViewer", () => {
  it("renders the file path in the header", () => {
    render(
      <FileContentViewer filePath="src/index.ts" content="const x = 1;" onClose={() => {}} />
    );
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("renders a close button", () => {
    const onClose = vi.fn();
    render(
      <FileContentViewer filePath="test.txt" content="hello" onClose={onClose} />
    );
    screen.getByText("Close").click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows loading state when content is null", () => {
    render(
      <FileContentViewer filePath="src/app.ts" content={null} onClose={() => {}} />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders file content in a code element with hljs class", () => {
    const { container } = render(
      <FileContentViewer filePath="hello.js" content="const x = 1;" onClose={() => {}} />
    );
    const codeEl = container.querySelector("code.hljs");
    expect(codeEl).not.toBeNull();
    expect(codeEl!.innerHTML).toBeTruthy();
  });

  it("renders content inside a pre element", () => {
    const { container } = render(
      <FileContentViewer filePath="test.txt" content="plain text" onClose={() => {}} />
    );
    const preEl = container.querySelector("pre");
    expect(preEl).not.toBeNull();
  });

  it("applies syntax highlighting for TypeScript files", () => {
    const { container } = render(
      <FileContentViewer
        filePath="src/app.ts"
        content="const greeting: string = 'hello';"
        onClose={() => {}}
      />
    );
    const codeEl = container.querySelector("code.hljs");
    // highlight.js wraps tokens in <span> elements
    const spans = codeEl!.querySelectorAll("span");
    expect(spans.length).toBeGreaterThan(0);
  });

  it("handles empty file content", () => {
    const { container } = render(
      <FileContentViewer filePath="empty.txt" content="" onClose={() => {}} />
    );
    const codeEl = container.querySelector("code.hljs");
    expect(codeEl).not.toBeNull();
  });

  it("renders the file path as title attribute for truncation", () => {
    render(
      <FileContentViewer
        filePath="very/long/path/to/some/deeply/nested/file.ts"
        content="code"
        onClose={() => {}}
      />
    );
    const pathEl = screen.getByTitle("very/long/path/to/some/deeply/nested/file.ts");
    expect(pathEl).toBeInTheDocument();
  });

  it("renders JSON content with highlighting", () => {
    const { container } = render(
      <FileContentViewer
        filePath="package.json"
        content='{"name": "test", "version": "1.0.0"}'
        onClose={() => {}}
      />
    );
    const codeEl = container.querySelector("code.hljs");
    const spans = codeEl!.querySelectorAll("span");
    expect(spans.length).toBeGreaterThan(0);
  });
});
