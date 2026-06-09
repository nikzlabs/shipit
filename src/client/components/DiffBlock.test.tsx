import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DiffBlock } from "./DiffBlock.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";

afterEach(() => {
  cleanup();
  useSessionStore.getState().reset();
  useFileStore.getState().reset();
});

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
      // The verb renders as an icon labeled with the verb, not the raw word.
      expect(screen.getByLabelText("Edit")).toBeInTheDocument();
    });

    it("shows 'write' label for write mode", () => {
      render(<DiffBlock filePath="src/app.ts" newString="content" isWrite />);
      expect(screen.getByLabelText("Write")).toBeInTheDocument();
    });

    it("shows a 'Delete' verb icon for a Codex delete (label override)", () => {
      render(<DiffBlock filePath="src/app.ts" unifiedDiff={"-old\n-line"} label="Delete" />);
      // Delete maps to the trash glyph, surfaced via aria-label/title.
      expect(screen.getByLabelText("Delete")).toBeInTheDocument();
    });

    it("falls back to the raw verb text when there's no glyph for it", () => {
      render(<DiffBlock filePath="src/app.ts" unifiedDiff={"+x"} label="Rename" />);
      // Unmapped verbs (e.g. a future Codex kind) render as plain text, not a glyph.
      expect(screen.getByText("Rename")).toBeInTheDocument();
      expect(screen.queryByLabelText("Rename")).toBeNull();
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

    it("does not count a trailing newline as an extra written line", () => {
      render(
        <DiffBlock filePath="f.ts" newString={"a\nb\n"} isWrite />
      );
      expect(screen.getByText("+2")).toBeInTheDocument();
      expect(screen.queryByText("+3")).not.toBeInTheDocument();
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

    it("shows fallback for an empty unified diff", () => {
      render(<DiffBlock filePath="f.ts" unifiedDiff="" />);
      expect(screen.getByText("no changes")).toBeInTheDocument();
    });
  });

  describe("file path", () => {
    it("opens the file preview when clicked", async () => {
      useSessionStore.getState().setSessionId("session-1");
      const openPreview = vi.spyOn(useFileStore.getState(), "openPreview").mockResolvedValue();

      render(<DiffBlock filePath="/workspace/src/app.ts" newString="hello" isWrite />);
      fireEvent.click(screen.getByRole("button", { name: "Open src/app.ts" }));

      await waitFor(() => {
        expect(openPreview).toHaveBeenCalledWith("session-1", "src/app.ts");
      });
    });
  });
});
