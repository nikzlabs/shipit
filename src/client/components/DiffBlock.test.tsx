import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { DiffBlock } from "./DiffBlock.js";
import { useFileStore } from "../stores/file-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { highlightCode } from "../syntax-highlight.js";

// Normalize highlight.js entities to DOM serialization.
function asRendered(html: string | null): string | null {
  if (html === null) return null;
  const el = document.createElement("code");
  el.innerHTML = html;
  return el.innerHTML;
}

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
      expect(screen.getByLabelText("Edit")).toBeInTheDocument();
    });

    it("shows 'write' label for write mode", () => {
      render(<DiffBlock filePath="src/app.ts" newString="content" isWrite />);
      expect(screen.getByLabelText("Write")).toBeInTheDocument();
    });

    it("shows a 'Delete' verb icon for a Codex delete (label override)", () => {
      render(<DiffBlock filePath="src/app.ts" unifiedDiff={"-old\n-line"} label="Delete" />);
      expect(screen.getByLabelText("Delete")).toBeInTheDocument();
    });

    it("falls back to the raw verb text when there's no glyph for it", () => {
      render(<DiffBlock filePath="src/app.ts" unifiedDiff={"+x"} label="Rename" />);
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

  describe("long-line wrapping", () => {
    const diffBody = () => screen.getByLabelText("Diff view").querySelector("pre:last-of-type")!;

    it("wraps an edit diff rather than scrolling it horizontally", () => {
      render(<DiffBlock filePath="f.ts" oldString={"x".repeat(400)} newString={"y".repeat(400)} />);
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

      const pre = diffBody();
      expect(pre.className).toMatch(/whitespace-pre-wrap/);
      expect(pre.className).not.toMatch(/overflow-x-auto/);
    });

    it("wraps a unified diff rather than scrolling it horizontally", () => {
      render(<DiffBlock filePath="f.ts" unifiedDiff={`+${"z".repeat(400)}`} />);
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

      const pre = diffBody();
      expect(pre.className).toMatch(/whitespace-pre-wrap/);
      expect(pre.className).not.toMatch(/overflow-x-auto/);
    });

    it("wraps a whole-file write rather than scrolling it horizontally", () => {
      render(<DiffBlock filePath="f.ts" newString={"q".repeat(400)} isWrite />);
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

      const pre = diffBody();
      expect(pre.className).toMatch(/whitespace-pre-wrap/);
      expect(pre.className).not.toMatch(/overflow-x-auto/);
    });
  });

  describe("write-content highlighting", () => {
    const writeBody = () => screen.getByLabelText("Diff view").querySelector("code.hljs");

    it("highlights a written file as the language of its path", () => {
      // Valid JSON and Python, with different highlighting.
      const content = '{"a": 1, "b": [2, 3]}';
      render(<DiffBlock filePath="/workspace/config.py" newString={content} isWrite />);
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

      expect(writeBody()?.innerHTML).toBe(asRendered(highlightCode(content, "python")));
      expect(writeBody()?.innerHTML).not.toBe(asRendered(highlightCode(content, null)));
    });

    it("falls back to auto-detection for an extension it does not know", () => {
      const content = "const x = 42;";
      render(<DiffBlock filePath="/workspace/data.parquet" newString={content} isWrite />);
      fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

      expect(writeBody()?.innerHTML).toBe(asRendered(highlightCode(content, null)));
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

describe("DiffBlock lazy body (docs/244)", () => {
  const LAZY_PROPS = { filePath: "src/app.ts", toolUseId: "toolu_lazy", stats: { added: 3, removed: 1 } };

  function stubSession() {
    useSessionStore.setState({ sessionId: "session-1" });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the summary from server stats, with no body present", () => {
    stubSession();
    render(<DiffBlock {...LAZY_PROPS} />);

    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
  });

  it("fetches the body from the tool-inputs endpoint when the modal opens", async () => {
    stubSession();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ input: { file_path: "src/app.ts", old_string: "before", new_string: "after" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DiffBlock {...LAZY_PROPS} />);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/tool-inputs/toolu_lazy");
    await waitFor(() => expect(screen.getByLabelText("Diff view")).toHaveTextContent("after"));
  });

  it("shows a loading state while the body is in flight, not a false empty diff", async () => {
    stubSession();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<DiffBlock {...LAZY_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading diff"));
  });

  it("surfaces an error rather than an empty diff when the fetch fails", async () => {
    stubSession();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(<DiffBlock {...LAZY_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => {
      const modal = screen.getByLabelText("Diff view");
      expect(modal.textContent).not.toContain("Loading diff");
      expect(modal.textContent).toContain("load this diff");
    });
  });

  it("does not fetch for a diff that arrived whole", async () => {
    stubSession();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<DiffBlock filePath="src/app.ts" oldString="before" newString="after" />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => expect(screen.getByLabelText("Diff view")).toHaveTextContent("after"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
