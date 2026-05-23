import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilePreviewModal } from "./FilePreviewModal.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import type { AgentOption } from "../agent-types.js";

// Monaco editor uses dynamic import("monaco-editor") and won't work in jsdom.
// Mock the module so the CodeEditor sub-component renders a simple div.
vi.mock("monaco-editor", () => ({
  editor: {
    create: () => ({
      dispose: vi.fn(),
      onMouseDown: () => ({ dispose: vi.fn() }),
      updateOptions: vi.fn(),
      changeViewZones: vi.fn(),
      createDecorationsCollection: vi.fn(),
    }),
  },
}));

afterEach(() => {
  cleanup();
  // Reset stores so per-test state doesn't bleed across cases.
  useSessionStore.getState().setSessionId(undefined);
  useUiStore.getState().setAgentList([]);
  useUiStore.getState().setActiveAgentId("claude");
});

const claudeOption: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  authConfigured: true,
  models: ["sonnet"],
  supportsReview: true,
};
const codexOption: AgentOption = {
  id: "codex",
  name: "Codex",
  installed: true,
  authConfigured: true,
  models: ["gpt-5.4"],
  supportsReview: false,
};

function setupSessionAndAgents(activeAgentId: "claude" | "codex") {
  useSessionStore.getState().setSessionId("session-1");
  useUiStore.getState().setAgentList([claudeOption, codexOption]);
  useUiStore.getState().setActiveAgentId(activeAgentId);
}

describe("FilePreviewModal", () => {
  it("renders the file path in the header", () => {
    render(
      <FilePreviewModal filePath="src/index.ts" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
  });

  it("renders a close button", () => {
    const onClose = vi.fn();
    render(
      <FilePreviewModal filePath="test.txt" content="hello" fileType="code" onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows loading state when content is null", () => {
    render(
      <FilePreviewModal filePath="src/app.ts" content={null} fileType="code" onClose={() => {}} />
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders code content in an editor container", () => {
    render(
      <FilePreviewModal filePath="hello.js" content="const x = 1;" fileType="code" onClose={() => {}} />
    );
    // CodeEditor renders a div with h-full w-full for the Monaco editor mount point
    // Content is portaled by Radix Dialog, so query the full document
    const editorDiv = document.querySelector(".h-full.w-full");
    expect(editorDiv).not.toBeNull();
  });

  it("renders markdown content via MarkdownSelectionComments", () => {
    render(
      <FilePreviewModal
        filePath="README.md"
        content="# Hello World"
        fileType="markdown"
        onClose={() => {}}
      />
    );
    // MarkdownSelectionComments renders the heading text
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("renders image content", () => {
    render(
      <FilePreviewModal
        filePath="photo.png"
        content="data:image/png;base64,abc123"
        fileType="image"
        onClose={() => {}}
      />
    );
    const img = screen.getByAltText("photo.png");
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc123");
  });

  it("renders binary file message", () => {
    render(
      <FilePreviewModal
        filePath="data.bin"
        content="Binary file — cannot display."
        fileType="binary"
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Binary file — cannot display.")).toBeInTheDocument();
  });

  it("renders action buttons in header", () => {
    const onAction = vi.fn();
    render(
      <FilePreviewModal
        filePath="plan.md"
        content="# Plan"
        fileType="markdown"
        actions={[{ label: "Start Session", onClick: onAction, variant: "primary" }]}
        onClose={() => {}}
      />
    );
    const btn = screen.getByText("Start Session");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("closes on Escape key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <FilePreviewModal filePath="test.txt" content="hello" fileType="code" onClose={onClose} />
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders the file path as title attribute for truncation", () => {
    render(
      <FilePreviewModal
        filePath="very/long/path/to/some/deeply/nested/file.ts"
        content="code"
        fileType="code"
        onClose={() => {}}
      />
    );
    const pathEl = screen.getByTitle("very/long/path/to/some/deeply/nested/file.ts");
    expect(pathEl).toBeInTheDocument();
  });

  // 125 — chat-native review. The "Ask agent to review" affordance only shows
  // when the active agent's capability flag says it can run the flow (Claude
  // only today). Codex sessions get no button (not a disabled one) because the
  // silent prod no-op the old button produced is strictly worse than nothing.
  describe("Ask agent to review gating (125)", () => {
    it("shows the button when active agent has supportsReview=true", () => {
      setupSessionAndAgents("claude");
      render(
        <FilePreviewModal
          filePath="docs/plan.md"
          content="# Plan"
          fileType="markdown"
          onClose={() => {}}
          onAskAgentReview={() => {}}
        />,
      );
      expect(screen.getByRole("button", { name: /ask agent to review/i })).toBeInTheDocument();
    });

    it("hides the button when active agent has supportsReview=false", () => {
      setupSessionAndAgents("codex");
      render(
        <FilePreviewModal
          filePath="docs/plan.md"
          content="# Plan"
          fileType="markdown"
          onClose={() => {}}
          onAskAgentReview={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: /ask agent to review/i })).not.toBeInTheDocument();
    });

    it("hides the button when there is no agent list yet (boot race)", () => {
      useSessionStore.getState().setSessionId("session-1");
      useUiStore.getState().setAgentList([]);
      render(
        <FilePreviewModal
          filePath="docs/plan.md"
          content="# Plan"
          fileType="markdown"
          onClose={() => {}}
          onAskAgentReview={() => {}}
        />,
      );
      expect(screen.queryByRole("button", { name: /ask agent to review/i })).not.toBeInTheDocument();
    });

    it("composes a delegation prompt and invokes onAskAgentReview with the file path", async () => {
      setupSessionAndAgents("claude");
      const onAskAgentReview = vi.fn();
      render(
        <FilePreviewModal
          filePath="docs/plan.md"
          content={"# Plan\n\n## Summary\nx"}
          fileType="markdown"
          onClose={() => {}}
          onAskAgentReview={onAskAgentReview}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: /ask agent to review/i }));
      expect(onAskAgentReview).toHaveBeenCalledOnce();
      const [prompt, filePath] = onAskAgentReview.mock.calls[0]!;
      expect(filePath).toBe("docs/plan.md");
      // The prompt must instruct delegation to a subagent and name the tool.
      expect(prompt).toContain("subagent");
      expect(prompt).toContain("submit_review_comments");
    });

    it("disables the button while the agent is mid-turn", () => {
      setupSessionAndAgents("claude");
      useSessionStore.getState().setIsLoading(true);
      render(
        <FilePreviewModal
          filePath="docs/plan.md"
          content="# Plan"
          fileType="markdown"
          onClose={() => {}}
          onAskAgentReview={() => {}}
        />,
      );
      expect(screen.getByRole("button", { name: /ask agent to review/i })).toBeDisabled();
      useSessionStore.getState().setIsLoading(false);
    });
  });

  // 114 — Sibling tabs let a user jump between a plan and its checklist (and
  // any other sibling .md files) without leaving the modal.
  describe("sibling tabs (114)", () => {
    const siblings = [
      { path: "docs/114-feature/plan.md", label: "Plan" },
      { path: "docs/114-feature/checklist.md", label: "Checklist" },
    ];

    it("renders a tab strip when there is more than one sibling", () => {
      render(
        <FilePreviewModal
          filePath="docs/114-feature/plan.md"
          content="# Plan"
          fileType="markdown"
          siblings={siblings}
          onSwitchSibling={() => {}}
          onClose={() => {}}
        />,
      );
      const tablist = screen.getByRole("tablist", { name: /related docs/i });
      expect(tablist).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "Checklist" })).toHaveAttribute("aria-selected", "false");
    });

    it("does not render a tab strip with a single sibling", () => {
      render(
        <FilePreviewModal
          filePath="docs/114-feature/plan.md"
          content="# Plan"
          fileType="markdown"
          siblings={[siblings[0]]}
          onSwitchSibling={() => {}}
          onClose={() => {}}
        />,
      );
      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    });

    it("calls onSwitchSibling when an inactive tab is clicked", () => {
      const onSwitchSibling = vi.fn();
      render(
        <FilePreviewModal
          filePath="docs/114-feature/plan.md"
          content="# Plan"
          fileType="markdown"
          siblings={siblings}
          onSwitchSibling={onSwitchSibling}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Checklist" }));
      expect(onSwitchSibling).toHaveBeenCalledExactlyOnceWith("docs/114-feature/checklist.md");
    });

    it("does not call onSwitchSibling when the active tab is clicked", () => {
      const onSwitchSibling = vi.fn();
      render(
        <FilePreviewModal
          filePath="docs/114-feature/plan.md"
          content="# Plan"
          fileType="markdown"
          siblings={siblings}
          onSwitchSibling={onSwitchSibling}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
      expect(onSwitchSibling).not.toHaveBeenCalled();
    });
  });
});
