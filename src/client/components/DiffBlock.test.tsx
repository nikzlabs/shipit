import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DiffBlock } from "./DiffBlock.js";

afterEach(cleanup);

describe("DiffBlock", () => {
  describe("file header", () => {
    it("displays the file path", () => {
      render(<DiffBlock filePath="src/app.ts" newString="hello" />);
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    });

    it("shows 'edit' label for edit mode", () => {
      render(
        <DiffBlock filePath="src/app.ts" oldString="old" newString="replaced" />
      );
      expect(screen.getByText("edit")).toBeInTheDocument();
    });

    it("shows 'write' label for write mode", () => {
      render(<DiffBlock filePath="src/app.ts" newString="content" isWrite />);
      expect(screen.getByText("write")).toBeInTheDocument();
    });
  });

  describe("edit mode — compact diff stat", () => {
    it("shows added and removed line counts", () => {
      render(
        <DiffBlock filePath="f.ts" oldString="removed line" newString="added line" />
      );
      expect(screen.getByText("+1")).toBeInTheDocument();
      expect(screen.getByText("-1")).toBeInTheDocument();
    });

    it("counts multi-line changes", () => {
      render(
        <DiffBlock
          filePath="f.ts"
          oldString={"line1\nline2\nline3"}
          newString={"a\nb"}
        />
      );
      expect(screen.getByText("+2")).toBeInTheDocument();
      expect(screen.getByText("-3")).toBeInTheDocument();
    });

    it("shows only added count when no old content", () => {
      render(<DiffBlock filePath="f.ts" newString={"a\nb\nc"} />);
      expect(screen.getByText("+3")).toBeInTheDocument();
      expect(screen.queryByText(/-\d+/)).not.toBeInTheDocument();
    });
  });

  describe("write mode — compact diff stat", () => {
    it("shows added line count", () => {
      render(
        <DiffBlock filePath="f.ts" newString={"a\nb\nc"} isWrite />
      );
      expect(screen.getByText("+3")).toBeInTheDocument();
    });

    it("does not show removed count in write mode", () => {
      render(
        <DiffBlock filePath="f.ts" newString="content" isWrite />
      );
      expect(screen.queryByText(/-\d+/)).not.toBeInTheDocument();
    });
  });

  describe("empty content", () => {
    it("shows fallback message when both old and new are empty", () => {
      render(<DiffBlock filePath="f.ts" />);
      expect(screen.getByText("no changes")).toBeInTheDocument();
    });

    it("shows fallback when old and new are undefined", () => {
      render(<DiffBlock filePath="f.ts" oldString={undefined} newString={undefined} />);
      expect(screen.getByText("no changes")).toBeInTheDocument();
    });
  });
});
