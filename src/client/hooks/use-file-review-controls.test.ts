import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useFileReviewControls } from "./use-file-review-controls.js";
import { useFileReviewStore } from "../stores/file-review-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import type { AgentOption } from "../agent-types.js";
import type { FileReview } from "../../server/shared/types.js";

const claude: AgentOption = {
  id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true,
  models: ["sonnet"], supportsReview: true,
};
const codex: AgentOption = {
  id: "codex", name: "Codex", installed: true, hasRunnableModels: true,
  models: ["gpt"], supportsReview: false,
};

beforeEach(() => {
  // Stub the draft-load fetch so the load effect doesn't hit the network.
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true, status: 200, json: async () => ({ id: "d1", comments: [], reviews: [] }),
  } as unknown as Response);
  useSessionStore.getState().setSessionId("sess_1");
  useUiStore.getState().setAgentList([claude, codex]);
  useUiStore.getState().setActiveAgentId("claude");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useFileReviewStore.setState({ draftByKey: {}, historyByKey: {}, composingByKey: {} });
  useSessionStore.getState().setSessionId(undefined);
  useUiStore.getState().setAgentList([]);
  useUiStore.getState().setActiveAgentId("claude");
});

describe("useFileReviewControls — reviewable gate", () => {
  it("is true for a workspace-relative markdown file", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x" }),
    );
    expect(result.current.reviewable).toBe(true);
  });

  it("is false for an absolute (/persist) artifact", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "/persist/x.html", kind: "html", content: "<h1/>" }),
    );
    expect(result.current.reviewable).toBe(false);
  });

  it("is false for a non-reviewable kind (image)", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.png", kind: "image", content: "data:..." }),
    );
    expect(result.current.reviewable).toBe(false);
  });
});

describe("useFileReviewControls — showAskReview gate", () => {
  it("shows for a reviewable file when the active agent supports review", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onAskAgentReview: () => {} }),
    );
    expect(result.current.showAskReview).toBe(true);
  });

  it("hides when the active agent does not support review (Codex)", () => {
    useUiStore.getState().setActiveAgentId("codex");
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onAskAgentReview: () => {} }),
    );
    expect(result.current.showAskReview).toBe(false);
  });

  it("hides when no onAskAgentReview handler is supplied", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x" }),
    );
    expect(result.current.showAskReview).toBe(false);
  });

  it("hides for a source view over the 10 KB cap", () => {
    const big = "x".repeat(11 * 1024);
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.html", kind: "html", content: big, onAskAgentReview: () => {} }),
    );
    expect(result.current.showAskReview).toBe(false);
  });

  it("allows a source view under the cap (html as code review)", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.html", kind: "html", content: "<h1/>", onAskAgentReview: () => {} }),
    );
    expect(result.current.showAskReview).toBe(true);
  });
});

describe("useFileReviewControls — canSend", () => {
  it("is false with no draft comments even when a handler exists", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments: () => {} }),
    );
    expect(result.current.commentCount).toBe(0);
    expect(result.current.canSend).toBe(false);
  });

  it("is false while a comment editor is open, even with draft comments", async () => {
    const onSendComments = vi.fn();
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments }),
    );

    // Seed a draft comment so only the composing flag can hold Send back. The
    // mount-time draft load resolves against the stubbed fetch (empty draft),
    // so re-seed after any awaited flush.
    const seedDraft = () => {
      act(() => {
        useFileReviewStore.setState({
          draftByKey: {
            "sess_1::docs/x.md": {
              id: "d1",
              sessionId: "sess_1",
              filePath: "docs/x.md",
              status: "draft",
              comments: [{
                id: "c1", kind: "selection", quotedText: "q", contextBefore: "", contextAfter: "",
                text: "note",
              }],
              createdAt: "", updatedAt: "",
            } as unknown as FileReview,
          },
        });
      });
    };

    seedDraft();
    expect(result.current.canSend).toBe(true);

    act(() => {
      useFileReviewStore.getState().setComposing("sess_1", "docs/x.md", true);
    });
    expect(result.current.composing).toBe(true);
    expect(result.current.canSend).toBe(false);

    // …and handleSend is a no-op while held, so a stray keyboard submit can't
    // open the send dialog over the editor — nor send from it (docs/260).
    act(() => { result.current.handleSend(); });
    expect(result.current.sendDialogOpen).toBe(false);
    await act(async () => { await result.current.confirmSend(); });
    expect(onSendComments).not.toHaveBeenCalled();

    seedDraft();
    act(() => {
      useFileReviewStore.getState().setComposing("sess_1", "docs/x.md", false);
    });
    expect(result.current.canSend).toBe(true);
  });
});

// docs/260 — Send is a two-step: it opens the confirmation dialog, and the
// dialog's own Send is what reaches the agent.
describe("useFileReviewControls — send dialog", () => {
  const seedDraft = () => {
    act(() => {
      useFileReviewStore.setState({
        draftByKey: {
          "sess_1::docs/x.md": {
            id: "d1",
            sessionId: "sess_1",
            filePath: "docs/x.md",
            status: "draft",
            comments: [{
              id: "c1", kind: "selection", quotedText: "q", contextBefore: "", contextAfter: "",
              text: "note",
            }],
            createdAt: "", updatedAt: "",
          } as unknown as FileReview,
        },
      });
    });
  };

  it("opens the dialog instead of sending", () => {
    const onSendComments = vi.fn();
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments }),
    );
    seedDraft();

    expect(result.current.sendDialogOpen).toBe(false);
    act(() => { result.current.handleSend(); });
    expect(result.current.sendDialogOpen).toBe(true);
    expect(onSendComments).not.toHaveBeenCalled();
  });

  it("does not open the dialog with an empty draft", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments: vi.fn() }),
    );
    act(() => { result.current.handleSend(); });
    expect(result.current.sendDialogOpen).toBe(false);
  });

  it("keeps the typed note when the dialog is cancelled", () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments: vi.fn() }),
    );
    seedDraft();

    act(() => { result.current.handleSend(); });
    act(() => { result.current.setNote("keep the structure"); });
    act(() => { result.current.closeSendDialog(); });

    expect(result.current.sendDialogOpen).toBe(false);
    expect(result.current.note).toBe("keep the structure");
  });

  it("confirmSend passes the note to sendDraft and closes the dialog", async () => {
    const onSendComments = vi.fn();
    const sendDraft = vi.fn().mockResolvedValue({
      prompt: "p", filePath: "docs/x.md", commentCount: 1,
    });
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments }),
    );
    seedDraft();
    act(() => { useFileReviewStore.setState({ sendDraft }); });

    act(() => { result.current.handleSend(); });
    act(() => { result.current.setNote("  overall: close  "); });
    await act(async () => { await result.current.confirmSend(); });

    expect(sendDraft).toHaveBeenCalledWith("sess_1", "docs/x.md", "  overall: close  ");
    expect(onSendComments).toHaveBeenCalledWith({
      prompt: "p", filePaths: ["docs/x.md"], commentCount: 1,
    });
    expect(result.current.sendDialogOpen).toBe(false);
    expect(result.current.note).toBe("");
  });

  // Two send affordances (the button and ⌘⏎) over an async POST: without the
  // in-flight guard the review is sent twice — two prompts, two agent turns.
  it("ignores a second confirm while the first send is in flight", async () => {
    const onSendComments = vi.fn();
    // A send held open on purpose, so a second confirm lands mid-flight.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { release = r; });
    const sendDraft = vi.fn().mockImplementation(async () => {
      await pending;
      return { prompt: "p", filePath: "docs/x.md", commentCount: 1 };
    });
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments }),
    );
    seedDraft();
    act(() => { useFileReviewStore.setState({ sendDraft }); });

    act(() => { result.current.handleSend(); });
    act(() => { void result.current.confirmSend(); });
    expect(result.current.sending).toBe(true);
    // …a second confirm lands while the first is still awaiting the server.
    await act(async () => { await result.current.confirmSend(); });
    expect(sendDraft).toHaveBeenCalledTimes(1);

    await act(async () => { release(null); await pending; });
    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(onSendComments).toHaveBeenCalledTimes(1);
    expect(result.current.sending).toBe(false);
  });

  // The hook follows the surface's active file (sibling tabs, Present
  // carousel), so unkeyed dialog state would carry A's note into B's review.
  it("drops the dialog and the note when the file changes", () => {
    const { result, rerender } = renderHook(
      ({ filePath }) => useFileReviewControls({
        filePath, kind: "markdown", content: "# x", onSendComments: vi.fn(),
      }),
      { initialProps: { filePath: "docs/x.md" } },
    );
    seedDraft();

    act(() => { result.current.handleSend(); });
    act(() => { result.current.setNote("this is about file A"); });
    expect(result.current.sendDialogOpen).toBe(true);

    rerender({ filePath: "docs/other.md" });

    expect(result.current.sendDialogOpen).toBe(false);
    expect(result.current.note).toBe("");
  });

  it("keeps the dialog open and reports the failure when the send fails", async () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments: vi.fn() }),
    );
    seedDraft();
    act(() => { useFileReviewStore.setState({ sendDraft: vi.fn().mockResolvedValue(null) }); });

    act(() => { result.current.handleSend(); });
    await act(async () => { await result.current.confirmSend(); });

    // Closing on failure looked exactly like success — no card, nothing sent.
    expect(result.current.sendDialogOpen).toBe(true);
    expect(result.current.sendError).toBeTruthy();
    expect(result.current.sending).toBe(false);
  });

  it("keeps the note when the send fails", async () => {
    const { result } = renderHook(() =>
      useFileReviewControls({ filePath: "docs/x.md", kind: "markdown", content: "# x", onSendComments: vi.fn() }),
    );
    seedDraft();
    act(() => { useFileReviewStore.setState({ sendDraft: vi.fn().mockResolvedValue(null) }); });

    act(() => { result.current.handleSend(); });
    act(() => { result.current.setNote("do not lose me"); });
    await act(async () => { await result.current.confirmSend(); });

    expect(result.current.note).toBe("do not lose me");
  });
});
