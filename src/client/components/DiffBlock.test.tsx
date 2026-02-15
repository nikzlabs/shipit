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

  describe("edit mode (old + new)", () => {
    it("renders removed lines with minus prefix", () => {
      render(
        <DiffBlock filePath="f.ts" oldString="removed line" newString="added line" />
      );
      const minusSigns = screen.getAllByText("-");
      expect(minusSigns.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("removed line")).toBeInTheDocument();
    });

    it("renders added lines with plus prefix", () => {
      render(
        <DiffBlock filePath="f.ts" oldString="before" newString="after" />
      );
      const plusSigns = screen.getAllByText("+");
      expect(plusSigns.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("after")).toBeInTheDocument();
    });

    it("renders multi-line old and new strings", () => {
      render(
        <DiffBlock
          filePath="f.ts"
          oldString={"line1\nline2"}
          newString={"line3\nline4"}
        />
      );
      expect(screen.getByText("line1")).toBeInTheDocument();
      expect(screen.getByText("line2")).toBeInTheDocument();
      expect(screen.getByText("line3")).toBeInTheDocument();
      expect(screen.getByText("line4")).toBeInTheDocument();
    });

    it("renders separator between removed and added lines", () => {
      const { container } = render(
        <DiffBlock filePath="f.ts" oldString="before" newString="after" />
      );
      const separator = container.querySelector(".border-t.border-gray-800");
      expect(separator).toBeInTheDocument();
    });

    it("does not render separator when only added lines", () => {
      const { container } = render(
        <DiffBlock filePath="f.ts" newString="only-added" />
      );
      const separator = container.querySelector(".border-t.border-gray-800");
      expect(separator).not.toBeInTheDocument();
    });
  });

  describe("write mode", () => {
    it("renders all lines as additions (green)", () => {
      render(
        <DiffBlock filePath="f.ts" newString={"a\nb\nc"} isWrite />
      );
      const plusSigns = screen.getAllByText("+");
      expect(plusSigns).toHaveLength(3);
    });

    it("does not render minus signs in write mode", () => {
      render(
        <DiffBlock filePath="f.ts" newString="content" isWrite />
      );
      expect(screen.queryAllByText("-")).toHaveLength(0);
    });
  });

  describe("empty content", () => {
    it("shows fallback message when both old and new are empty", () => {
      render(<DiffBlock filePath="f.ts" />);
      expect(screen.getByText("No content changes")).toBeInTheDocument();
    });

    it("shows fallback when old and new are undefined", () => {
      render(<DiffBlock filePath="f.ts" oldString={undefined} newString={undefined} />);
      expect(screen.getByText("No content changes")).toBeInTheDocument();
    });
  });
});
