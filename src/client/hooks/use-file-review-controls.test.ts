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
                text: "note", source: "human",
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
    // send the draft out from under the open editor.
    await act(async () => { await result.current.handleSend(); });
    expect(onSendComments).not.toHaveBeenCalled();

    seedDraft();
    act(() => {
      useFileReviewStore.getState().setComposing("sess_1", "docs/x.md", false);
    });
    expect(result.current.canSend).toBe(true);
  });
});
