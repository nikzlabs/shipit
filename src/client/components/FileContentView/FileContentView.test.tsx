import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FileContentView } from "./FileContentView.js";
import { svgToMarkup } from "./RenderedFrame.js";

// Monaco uses dynamic import("monaco-editor") and won't run in jsdom — stub it
// so the source/code views render their mount div.
vi.mock("monaco-editor", () => ({
  editor: {
    create: () => ({
      dispose: vi.fn(),
      onMouseDown: () => ({ dispose: vi.fn() }),
      updateOptions: vi.fn(),
      changeViewZones: vi.fn(),
      createDecorationsCollection: vi.fn(),
      getModel: () => ({ getLineCount: () => 1 }),
    }),
  },
}));

afterEach(cleanup);

const base = {
  sessionId: "",
  reviewable: false,
  markdownComments: [],
  codeComments: [],
};

describe("FileContentView dispatch", () => {
  it("renders markdown via MarkdownSelectionComments (heading text)", () => {
    render(
      <FileContentView {...base} filePath="docs/x.md" content="# Hello World" kind="markdown" viewMode="rendered" />,
    );
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("renders an image", () => {
    render(
      <FileContentView {...base} filePath="a/b.png" content="data:image/png;base64,abc" kind="image" viewMode="rendered" />,
    );
    const img = screen.getByAltText("a/b.png");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc");
  });

  it("renders the binary placeholder", () => {
    render(
      <FileContentView {...base} filePath="a.bin" content="" kind="binary" viewMode="rendered" />,
    );
    expect(screen.getByText("Binary file — cannot display.")).toBeInTheDocument();
  });

  it("renders HTML in a sandboxed frame with an injected CSP", () => {
    render(
      <FileContentView {...base} filePath="m.html" content="<h1>Hi</h1>" kind="html" viewMode="rendered" />,
    );
    const iframe = screen.getByTitle("Rendered content");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<h1>Hi</h1>");
    expect(srcdoc).toContain("connect-src 'none'");
  });

  it("shows the Monaco mount when HTML is toggled to source", () => {
    render(
      <FileContentView {...base} filePath="m.html" content="<h1>Hi</h1>" kind="html" viewMode="source" />,
    );
    expect(screen.queryByTitle("Rendered content")).toBeNull();
    expect(document.querySelector(".h-full.w-full")).not.toBeNull();
  });

  it("decodes a base64 data-URI SVG into raw markup for the rendered frame", () => {
    // "<svg></svg>" base64-encoded.
    const dataUri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    render(
      <FileContentView {...base} filePath="i.svg" content={dataUri} kind="svg" viewMode="rendered" />,
    );
    const srcdoc = screen.getByTitle("Rendered content").getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<svg></svg>");
    expect(srcdoc).not.toContain("data:image/svg+xml");
  });
});

describe("svgToMarkup", () => {
  it("returns raw markup unchanged", () => {
    expect(svgToMarkup("<svg/>")).toBe("<svg/>");
  });
  it("decodes a base64 data URI", () => {
    expect(svgToMarkup("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe("<svg></svg>");
  });
  it("decodes a url-encoded data URI", () => {
    expect(svgToMarkup("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E")).toBe("<svg></svg>");
  });
});
