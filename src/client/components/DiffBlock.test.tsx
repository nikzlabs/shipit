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

/**
 * docs/244 — the lazy Edit/Write body. The server strips `oldString`/`newString`
 * from the transcript and sends `stats` plus the `toolUseId` to fetch with; the
 * modal is the moment the body has to arrive.
 *
 * The independent requirements review flagged this half as unpinned: an
 * integration test proved the *endpoint*, but nothing proved the UI calls it,
 * renders what comes back, or degrades sanely when it doesn't. So a refactor
 * that dropped the fetch would have left every diff modal permanently blank
 * with a green suite.
 */
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

    // The whole point: the inline row looks identical to a non-lazy one, so
    // requirement 8's "no loading states in the transcript" holds.
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
    // Nothing is fetched until the user asks for it.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/session-1/tool-inputs/toolu_lazy");
    await waitFor(() => expect(screen.getByLabelText("Diff view")).toHaveTextContent("after"));
  });

  it("shows a loading state while the body is in flight, not a false empty diff", async () => {
    stubSession();
    // A fetch that never settles — the state the user sees on a slow link.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<DiffBlock {...LAZY_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading diff"));
  });

  it("surfaces an error rather than an empty diff when the fetch fails", async () => {
    stubSession();
    // A 404 is the realistic failure: the row was rewound out from under the id.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    render(<DiffBlock {...LAZY_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }));

    await waitFor(() => {
      const modal = screen.getByLabelText("Diff view");
      expect(modal.textContent).not.toContain("Loading diff");
      // The claim under test is "an ordinary error is surfaced", not the exact
      // sentence — but an empty modal would pass a looser check, so anchor on
      // the failure being *stated*.
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
