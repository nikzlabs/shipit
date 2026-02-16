import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolResult, truncateLines } from "./ToolResult.js";
import type { ToolResultBlock } from "./MessageList.js";

afterEach(cleanup);

function result(content: string, isError?: boolean): ToolResultBlock {
  return { toolUseId: "toolu_test", content, isError };
}

describe("truncateLines", () => {
  it("returns full text when under the limit", () => {
    const r = truncateLines("line1\nline2\nline3", 5);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("line1\nline2\nline3");
    expect(r.totalLines).toBe(3);
  });

  it("truncates text when over the limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = truncateLines(lines, 10);
    expect(r.truncated).toBe(true);
    expect(r.text.split("\n")).toHaveLength(10);
    expect(r.totalLines).toBe(50);
  });

  it("returns exact limit lines without truncation", () => {
    const lines = "a\nb\nc";
    const r = truncateLines(lines, 3);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("a\nb\nc");
  });
});

describe("ToolResult", () => {
  describe("empty/no output", () => {
    it("shows '(no output)' for empty content with no error", () => {
      render(<ToolResult tool="Bash" result={result("")} />);
      expect(screen.getByText("(no output)")).toBeInTheDocument();
    });

    it("renders error result even when content is empty", () => {
      render(<ToolResult tool="Bash" result={result("", true)} />);
      // Should not show "(no output)" for error results — show the error container
      expect(screen.queryByText("(no output)")).toBeNull();
    });
  });

  describe("BashResult", () => {
    it("renders Bash output in a monospace block", () => {
      const { container } = render(
        <ToolResult tool="Bash" result={result("test output")} />
      );
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.className).toContain("font-mono");
      expect(pre?.textContent).toContain("test output");
    });

    it("highlights errors in red", () => {
      const { container } = render(
        <ToolResult tool="Bash" result={result("command failed", true)} />
      );
      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("text-red-300");
    });

    it("does not use red text for non-error output", () => {
      const { container } = render(
        <ToolResult tool="Bash" result={result("success")} />
      );
      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("text-gray-300");
      expect(pre?.className).not.toContain("text-red-300");
    });

    it("shows error border for error results", () => {
      const { container } = render(
        <ToolResult tool="Bash" result={result("error", true)} />
      );
      const wrapper = container.querySelector("div.mt-1");
      expect(wrapper?.className).toContain("border-red-700");
    });

    it("truncates long output and shows expand button", () => {
      const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="Bash" result={result(longOutput)} />);
      expect(screen.getByText(/Show all 50 lines/)).toBeInTheDocument();
    });

    it("does not show expand button for short output", () => {
      render(<ToolResult tool="Bash" result={result("short output")} />);
      expect(screen.queryByText(/Show all/)).toBeNull();
    });

    it("expands output when expand button is clicked", () => {
      const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="Bash" result={result(longOutput)} />);

      fireEvent.click(screen.getByText(/Show all 50 lines/));
      expect(screen.getByText("Show less")).toBeInTheDocument();
      // The full content should be visible
      expect(screen.getByText(/line 50/)).toBeInTheDocument();
    });

    it("collapses output when Show less is clicked", () => {
      const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="Bash" result={result(longOutput)} />);

      fireEvent.click(screen.getByText(/Show all 50 lines/));
      fireEvent.click(screen.getByText("Show less"));
      expect(screen.getByText(/Show all 50 lines/)).toBeInTheDocument();
    });

    it("has accessible aria-label on expand button", () => {
      const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="Bash" result={result(longOutput)} />);
      expect(screen.getByLabelText("Show more output")).toBeInTheDocument();
    });
  });

  describe("ReadResult", () => {
    it("renders file content in a code block", () => {
      const { container } = render(
        <ToolResult tool="Read" result={result("const x = 1;\nconst y = 2;")} />
      );
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toContain("const x = 1");
    });

    it("applies syntax highlighting via hljs", () => {
      const { container } = render(
        <ToolResult tool="Read" result={result("const x = 42;")} />
      );
      const code = container.querySelector("code.hljs");
      expect(code).not.toBeNull();
    });

    it("truncates at 20 lines with expand button", () => {
      const longContent = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="Read" result={result(longContent)} />);
      expect(screen.getByText(/Show all 40 lines/)).toBeInTheDocument();
    });
  });

  describe("GrepResult", () => {
    it("renders grep output with colored file paths", () => {
      const grepOutput = "src/app.ts:10:const x = 1;\nsrc/app.ts:20:const y = 2;";
      const { container } = render(
        <ToolResult tool="Grep" result={result(grepOutput)} />
      );
      // File paths should be colored blue
      const blueParts = container.querySelectorAll("span.text-blue-400");
      expect(blueParts.length).toBeGreaterThan(0);
      expect(blueParts[0].textContent).toBe("src/app.ts");
    });

    it("renders line numbers in yellow", () => {
      const grepOutput = "file.ts:42:some match";
      const { container } = render(
        <ToolResult tool="Grep" result={result(grepOutput)} />
      );
      const yellowParts = container.querySelectorAll("span.text-yellow-400");
      expect(yellowParts.length).toBeGreaterThan(0);
      expect(yellowParts[0].textContent).toBe("42");
    });

    it("renders file-only matches as blue paths", () => {
      const grepOutput = "src/app.ts\nsrc/index.ts";
      const { container } = render(
        <ToolResult tool="Grep" result={result(grepOutput)} />
      );
      const blueParts = container.querySelectorAll("span.text-blue-400");
      expect(blueParts.length).toBe(2);
    });

    it("truncates at 20 lines", () => {
      const longOutput = Array.from({ length: 30 }, (_, i) => `file.ts:${i}:match ${i}`).join("\n");
      render(<ToolResult tool="Grep" result={result(longOutput)} />);
      expect(screen.getByText(/Show all 30 lines/)).toBeInTheDocument();
    });

    it("also handles Glob tool", () => {
      const globOutput = "src/app.ts\nsrc/index.ts\nsrc/utils.ts";
      const { container } = render(
        <ToolResult tool="Glob" result={result(globOutput)} />
      );
      const blueParts = container.querySelectorAll("span.text-blue-400");
      expect(blueParts.length).toBe(3);
    });
  });

  describe("GenericResult", () => {
    it("renders unknown tool output as plain monospace text", () => {
      const { container } = render(
        <ToolResult tool="WebFetch" result={result("some web content")} />
      );
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.className).toContain("font-mono");
      expect(pre?.textContent).toContain("some web content");
    });

    it("renders error output in red", () => {
      const { container } = render(
        <ToolResult tool="Unknown" result={result("error occurred", true)} />
      );
      const pre = container.querySelector("pre");
      expect(pre?.className).toContain("text-red-300");
    });

    it("truncates at 15 lines", () => {
      const longOutput = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
      render(<ToolResult tool="WebSearch" result={result(longOutput)} />);
      expect(screen.getByText(/Show all 25 lines/)).toBeInTheDocument();
    });
  });
});
