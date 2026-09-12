import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";
import type { PermissionMode } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { handleResetEligible } from "../hooks/message-handlers/reset-eligible.js";
import { INSET_FOCUS_RING } from "../design-tokens.js";

afterEach(cleanup);

function mockMatchMedia(isMobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? isMobile : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

beforeEach(() => {

  mockMatchMedia(false);
});

describe("MessageInput", () => {
  describe("basic functionality", () => {
    it("renders the input textarea and send button", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      expect(screen.getByPlaceholderText("Describe what to build... (type @ to attach files)")).toBeInTheDocument();
      expect(screen.getByLabelText("Send message")).toBeInTheDocument();
    });

    it("renders the add files button", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      expect(screen.getByLabelText("Add files")).toBeInTheDocument();
    });

    it("sends text message on submit", () => {
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "Hello Claude" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello Claude" }));
    });

    it("sends text on Enter (without Shift)", () => {
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "test" }));
    });

    it("does NOT send on Enter when on a mobile viewport", () => {

      mockMatchMedia(true);
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).not.toHaveBeenCalled();
    });

    it("still sends via the send button on a mobile viewport", () => {
      mockMatchMedia(true);
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "hello mobile" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "hello mobile" }));
    });

    it("does not send empty messages", () => {
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} />);
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).not.toHaveBeenCalled();
    });

    it("disables send button when disabled prop is true", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={true} />);
      expect(screen.getByLabelText("Send message")).toBeDisabled();
    });
  });

  describe("live steering (docs/140)", () => {

    it("renders both Stop and Send while running when steering is active", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          isLoading={true}
          onInterrupt={vi.fn()}
          liveSteeringActive={true}
        />,
      );
      expect(screen.getByTestId("stop-button")).toBeInTheDocument();
      expect(screen.getByTestId("send-button")).toBeInTheDocument();
    });

    it("enables the send button while running once text is typed (steer mid-turn)", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          isLoading={true}
          onInterrupt={vi.fn()}
          liveSteeringActive={true}
        />,
      );
      const sendButton = screen.getByTestId("send-button");

      expect(sendButton).toBeDisabled();

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "also update the README" } });

      expect(sendButton).not.toBeDisabled();
    });

    it("sends the steered message while running without stopping the agent", () => {
      const onSend = vi.fn().mockReturnValue(true);
      const onInterrupt = vi.fn();
      render(
        <MessageInput
          onSend={onSend}
          disabled={false}
          isLoading={true}
          onInterrupt={onInterrupt}
          liveSteeringActive={true}
        />,
      );
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "steer this in" } });
      fireEvent.click(screen.getByTestId("send-button"));

      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "steer this in" }));
      // Sending a steer must NOT interrupt the running turn.
      expect(onInterrupt).not.toHaveBeenCalled();
    });

    it("shows only Stop (no Send) while running when steering is OFF — legacy queue path", () => {

      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          isLoading={true}
          onInterrupt={vi.fn()}
        />,
      );
      expect(screen.getByTestId("stop-button")).toBeInTheDocument();
      expect(screen.queryByTestId("send-button")).not.toBeInTheDocument();
    });

    it("does not render Send mid-turn when steering is explicitly disabled", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          isLoading={true}
          onInterrupt={vi.fn()}
          liveSteeringActive={false}
        />,
      );
      expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument();
    });
  });

  describe("permission mode selector", () => {
    const claudeWithModes = [{
      id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true,
      models: ["claude-sonnet-4"], supportsReview: true,
      supportedPermissionModes: ["auto", "plan", "guarded"] as PermissionMode[],
    }];

    it("renders permission mode selector when onPermissionModeChange is provided and the agent supports modes", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          onPermissionModeChange={vi.fn()}
          agents={claudeWithModes}
          activeAgentId="claude"
        />,
      );
      expect(screen.getByTestId("permission-mode-selector")).toBeInTheDocument();
    });

    it("does not render permission mode selector when onPermissionModeChange is not provided", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} agents={claudeWithModes} activeAgentId="claude" />);
      expect(screen.queryByTestId("permission-mode-selector")).not.toBeInTheDocument();
    });

    it("hides the selector for an agent that advertises no permission modes", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          onPermissionModeChange={vi.fn()}
          agents={[{ id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5"], supportsReview: false, supportedPermissionModes: [] }]}
          activeAgentId="codex"
        />,
      );
      expect(screen.queryByTestId("permission-mode-selector")).not.toBeInTheDocument();
    });
  });

  describe("harness and model selectors", () => {

    it("renders both when onAgentChange is provided", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          onAgentChange={vi.fn()}
          agents={[{ id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true, models: ["claude-opus-4-8"], supportsReview: true }]}
          modelInfo={{ model: "claude-opus-4-8", contextWindowTokens: 200000 }}
        />,
      );
      expect(screen.getByTestId("harness-selector")).toBeInTheDocument();
      expect(screen.getByTestId("model-selector")).toBeInTheDocument();
      expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
    });
  });

  describe("drag and drop", () => {
    it("shows drop zone overlay when dragging over", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.px-4")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
    });

    it("hides drop zone overlay when dragging out", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.px-4")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
      fireEvent.dragLeave(container, { dataTransfer: { files: [] } });
      expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
    });
  });

  describe("focus reclaim on blur", () => {

    it("does NOT reclaim focus when blur leaves activeElement=body", async () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      textarea.blur();
      fireEvent.blur(textarea, { relatedTarget: null });
      expect(document.activeElement).toBe(document.body);

      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      expect(document.activeElement).toBe(document.body);
    });

    it("DOES reclaim focus when an iframe load steals focus mid-typing", async () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
      textarea.focus();
      focusSpy.mockClear();

      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      iframe.dispatchEvent(new Event("load"));

      iframe.focus();

      Object.defineProperty(document, "activeElement", { configurable: true, get: () => iframe });
      fireEvent.blur(textarea, { relatedTarget: null });

      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      // iframe, because the steal immediately followed a load event.
      expect(focusSpy).toHaveBeenCalled();

      delete (document as unknown as Record<string, unknown>).activeElement;
      iframe.remove();
    });

    it("does NOT reclaim focus when the user moves into an iframe (no recent load)", async () => {

      // recent iframe LOAD event; with no load, the move is intentional and we leave

      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
      textarea.focus();
      focusSpy.mockClear();

      const iframe = document.createElement("iframe");
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => iframe });
      fireEvent.blur(textarea, { relatedTarget: null });

      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      // Reclaim must NOT fire — focus stays in the iframe so the right-side surface

      expect(focusSpy).not.toHaveBeenCalled();

      delete (document as unknown as Record<string, unknown>).activeElement;
      iframe.remove();
    });
  });

  describe("auto-focus on session change", () => {

    const waitForFocusRaf = async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };

    it("focuses the textarea when focusKey changes on desktop", async () => {
      const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);

      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
      expect(document.activeElement).toBe(document.body);

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-B" />);
      await waitForFocusRaf();

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(document.activeElement).toBe(textarea);
    });

    it("does NOT focus the textarea when focusKey changes on a mobile viewport", async () => {

      mockMatchMedia(true);
      const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
      expect(document.activeElement).toBe(document.body);

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-B" />);
      await waitForFocusRaf();

      expect(document.activeElement).toBe(document.body);
    });

    it("does not run the chat focusKey path for overlay surface changes", async () => {
      const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="overlay-A" surface="overlay" />);
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="overlay-B" surface="overlay" />);
      await waitForFocusRaf();

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(document.activeElement).toBe(textarea);
    });
  });

  describe("overlay surface", () => {
    afterEach(() => {
      useSessionStore.getState().setPrefillText(undefined);
    });

    it("does not consume chat prefill text", async () => {
      useSessionStore.getState().setPrefillText("send this to chat");
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="overlay" surface="overlay" />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
      expect(useSessionStore.getState().prefillText).toBe("send this to chat");
    });

    it("auto-focuses the textarea on mount on desktop", async () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} surface="overlay" />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(document.activeElement).toBe(textarea);
    });

    it("auto-focuses the textarea on mount on a mobile viewport", async () => {

      mockMatchMedia(true);
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} surface="overlay" />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(document.activeElement).toBe(textarea);
    });

    it("hides the context dial even when model info is present", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          surface="overlay"
          modelInfo={{ model: "Opus", contextWindowTokens: 200000 }}
          contextTokens={1200}
        />,
      );
      expect(screen.queryByTestId("context-dial")).not.toBeInTheDocument();
    });
  });

  describe("per-session draft persistence", () => {
    beforeEach(() => {
      localStorage.clear();
    });
    afterEach(() => {
      localStorage.clear();
    });

    it("loads a saved draft for the active session on mount", () => {
      localStorage.setItem("shipit-draft-message:session-A", "draft for A");
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      expect(textarea.value).toBe("draft for A");
    });

    it("saves typed text under the active session's focusKey", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "in progress" } });
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("in progress");
    });

    it("swaps drafts when focusKey changes", () => {
      localStorage.setItem("shipit-draft-message:session-B", "B's draft");
      const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "A's draft" } });
      expect(textarea.value).toBe("A's draft");

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-B" />);
      expect(textarea.value).toBe("B's draft");
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("A's draft");

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      expect(textarea.value).toBe("A's draft");
    });

    it("shows empty input when switching to a session with no saved draft", () => {
      const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "A's draft" } });

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-fresh" />);
      expect(textarea.value).toBe("");
    });

    it("preserves typed text while focusKey is held stable across re-renders (new-session graduation)", () => {

      // seconds after mount and sets sessionId in the store. App.tsx must

      // must NOT clear the textarea on re-render, even when other props change.
      const { rerender } = render(
        <MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={true} focusKey="new" />,
      );
      const textarea = screen.getByPlaceholderText(
        "Describe what to build... (type @ to attach files)",
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello world" } });
      expect(textarea.value).toBe("hello world");

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="new" />);
      expect(textarea.value).toBe("hello world");
    });

    it("keeps each repo's new-session draft separate (docs/259 req 4)", () => {

      const { rerender } = render(
        <MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="new:owner/alpha" />,
      );
      const textarea = screen.getByPlaceholderText(
        "Describe what to build... (type @ to attach files)",
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "fix the alpha crash" } });

      // Switch to another repo's new-session view: alpha's text must not follow.
      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="new:owner/beta" />);
      expect(textarea.value).toBe("");
      fireEvent.change(textarea, { target: { value: "beta readme" } });

      rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="new:owner/alpha" />);
      expect(textarea.value).toBe("fix the alpha crash");
      expect(localStorage.getItem("shipit-draft-message:new:owner/beta")).toBe("beta readme");
    });

    it("does not load or save drafts on the overlay surface", () => {

      localStorage.setItem("shipit-draft-message:__quick_capture__", "stale overlay draft");

      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          surface="overlay"
          focusKey="__quick_capture__"
        />,
      );
      const textarea = screen.getByPlaceholderText(
        "Describe what to build... (type @ to attach files)",
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe("");

      fireEvent.change(textarea, { target: { value: "fresh prompt" } });
      expect(localStorage.getItem("shipit-draft-message:__quick_capture__")).toBe("stale overlay draft");
    });

    it("clears the saved draft after sending", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "ship it" } });
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("ship it");
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBeNull();
    });
  });

  describe("file picker", () => {
    it("has a hidden file input that accepts all file types", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
      const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
      expect(fileInput.type).toBe("file");
      expect(fileInput.accept).toBe("");                          
      expect(fileInput.multiple).toBe(true);
    });

    it("buffers attached files in overlay surface and surfaces them as deferredFiles on send", () => {
      const onSend = vi.fn().mockReturnValue(true);

      render(<MessageInput onSend={onSend} disabled={false} surface="overlay" />);
      const fileInput = screen.getByTestId("file-input");

      const textFile = new File(["hello"], "doc.txt", { type: "text/plain" });
      const pngFile = new File(["img"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [textFile, pngFile] } });

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "go" } });
      fireEvent.click(screen.getByLabelText("Send message"));

      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "go",
          deferredFiles: [textFile, pngFile],
          uploadRefs: [],
        }),
      );
    });
  });

  describe("skill autocomplete", () => {
    const skills = [
      { name: "deploy", description: "Deploy the app", source: "project" as const },
      { name: "review", description: "Review a PR", source: "project" as const },
    ];

    it("opens on a leading slash and lists skills", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
      expect(screen.getByTestId("skill-autocomplete")).toBeInTheDocument();
      expect(screen.getAllByTestId("skill-autocomplete-item")).toHaveLength(2);
    });

    it("filters skills by the query after the slash", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/dep", selectionStart: 4 } });
      const items = screen.getAllByTestId("skill-autocomplete-item");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("/deploy");
    });

    it("inserts the selected skill name with a trailing space", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
      fireEvent.click(screen.getByText("/review"));
      expect(textarea.value).toBe("/review ");
    });

    it("does not open when the slash is not at the start", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "hello /deploy", selectionStart: 13 } });
      expect(screen.queryByTestId("skill-autocomplete")).not.toBeInTheDocument();
    });

    it("does not open when no skills are available", () => {
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={[]} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
      expect(screen.queryByTestId("skill-autocomplete")).not.toBeInTheDocument();
    });

    it("opens on a leading slash for Codex but displays the $ token", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} activeAgentId="codex"
          agents={[{ id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5"], supportsReview: false, skillInvocationPrefix: "$" }]}
        />,
      );
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/dep", selectionStart: 4 } });
      const items = screen.getAllByTestId("skill-autocomplete-item");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("$deploy");
    });

    it("inserts $name for Codex instead of /name", () => {
      render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)} disabled={false} skills={skills} activeAgentId="codex"
          agents={[{ id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5"], supportsReview: false, skillInvocationPrefix: "$" }]}
        />,
      );
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
      fireEvent.click(screen.getByText("$review"));
      expect(textarea.value).toBe("$review ");
    });
  });

  describe("docs/218 — start-from-latest-base control", () => {
    const typeAndSend = () => {
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "next slice of work" } });
      fireEvent.click(screen.getByLabelText("Send message"));
    };

    afterEach(() => {
      usePrStore.setState({ resetEligibleBySession: {}, mergeContinueOptOutBySession: {} });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      localStorage.clear();
    });

    it("is hidden when the session is not reset-eligible", () => {
      usePrStore.setState({ resetEligibleBySession: {} });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} sessionId="s1" />);
      expect(screen.queryByTestId("reset-merged-branch-control")).not.toBeInTheDocument();
    });

    it("is hidden when eligible but the global setting is off", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: false });
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} sessionId="s1" />);
      expect(screen.queryByTestId("reset-merged-branch-control")).not.toBeInTheDocument();
    });

    it("shows when eligible + setting on, and sends resetMergedBranch:true checked by default", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} sessionId="s1" />);
      expect(screen.getByTestId("reset-merged-branch-control")).toBeInTheDocument();
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ resetMergedBranch: true }));
    });

    it("sends resetMergedBranch:false after the user unticks it (per-send opt-out)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("reset-merged-branch-control"));
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ resetMergedBranch: false }));
    });

    it("optimistically clears eligibility (hides the control) on a checked send", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} sessionId="s1" />);
      typeAndSend();

      expect(usePrStore.getState().resetEligibleBySession.s1).toBeUndefined();
      expect(screen.queryByTestId("reset-merged-branch-control")).not.toBeInTheDocument();
    });

    it("keeps eligibility (control stays armed) on an unticked send", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("reset-merged-branch-control"));          
      typeAndSend();
      // No reset will run, so the signal must not be optimistically cleared —

      expect(usePrStore.getState().resetEligibleBySession.s1).toBe(true);
    });

    it("keeps the untick when eligibility flickers between the untick and the send", () => {
      // docs/295 — the sibling control has the identical shape, so it had the
      // identical defect: an eligibility answer arriving in between re-ticked
      // it, and a send made while the control was away carried no intent at
      // all — which the server reads as "follow the setting", i.e. reset.
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = vi.fn().mockReturnValue(true);
      render(<MessageInput onSend={onSend} disabled={false} sessionId="s1" />);
      fireEvent.click(screen.getByTestId("reset-merged-branch-control")); // untick
      act(() => {
        handleResetEligible(
          { terminalRef: { current: null }, queuedMessageStash: new Map() },
          { type: "reset_eligible", sessionId: "s1", eligible: false },
        );
      });
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ resetMergedBranch: false }));
    });
  });

  describe("docs/154 — /goal in the / menu (req 5)", () => {
    const openMenu = (supportsGoals: boolean, goalActions?: AgentOption["goalActions"]) => {
      render(
        <MessageInput
          onSend={vi.fn()}
          disabled={false}
          sessionId="s1"
          agents={[{
            id: "codex" as const,
            name: "Codex",
            installed: true,
            hasRunnableModels: true,
            models: [],
            supportsReview: true,
            supportsCompaction: true,
            supportsGoals,
            ...(goalActions ? { goalActions } : {}),
          }]}
          activeAgentId="codex"
        />,
      );
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/" } });
    };

    it("offers the goal commands when the agent supports goals", () => {
      openMenu(true);
      expect(screen.getByText("/goal")).toBeInTheDocument();
      expect(screen.getByText("/goal clear")).toBeInTheDocument();
      expect(screen.getByText("/goal pause")).toBeInTheDocument();
      expect(screen.getByText("/goal resume")).toBeInTheDocument();
    });

    it("offers none when it does not", () => {
      openMenu(false);
      expect(screen.getByText("/compact")).toBeInTheDocument();
      expect(screen.queryByText("/goal clear")).not.toBeInTheDocument();
    });

    // docs/298 — an action the harness refuses must not be offered; picking it would only warn.
    it("leaves out an action the agent does not declare", () => {
      openMenu(true, { get: "control", set: "turn", clear: "control" });
      expect(screen.getByText("/goal")).toBeInTheDocument();
      expect(screen.getByText("/goal clear")).toBeInTheDocument();
      expect(screen.queryByText("/goal pause")).not.toBeInTheDocument();
      expect(screen.queryByText("/goal resume")).not.toBeInTheDocument();
    });
  });

  describe("docs/295 — compact-the-context control", () => {
    const compactingAgent = [{
      id: "claude" as const,
      name: "Claude Code",
      installed: true,
      hasRunnableModels: true,
      models: ["claude-opus-4-8"],
      supportsReview: true,
      supportsCompaction: true,
    }];
    const nonCompactingAgent = [{ ...compactingAgent[0]!, supportsCompaction: false }];

    const renderComposer = (
      onSend = vi.fn(),
      agents: typeof compactingAgent = compactingAgent,
    ) => {
      render(
        <MessageInput
          onSend={onSend}
          disabled={false}
          sessionId="s1"
          agents={agents}
          activeAgentId="claude"
        />,
      );
      return onSend;
    };

    const typeAndSend = () => {
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "next slice of work" } });
      fireEvent.click(screen.getByLabelText("Send message"));
    };

    /**
     * The server's own signal, not a raw `setState`.
     *
     * The distinction is the whole point of the incident below: the composer
     * ALSO writes `resetEligibleBySession` (the optimistic hide on a ticked
     * send), so a test that pokes the map directly cannot tell the two writers
     * apart — and the tick state must react to neither.
     */
    const serverSaysEligible = (eligible: boolean, sessionId = "s1") => {
      act(() => {
        handleResetEligible(
          { terminalRef: { current: null }, queuedMessageStash: new Map() },
          { type: "reset_eligible", sessionId, eligible },
        );
      });
    };

    afterEach(() => {
      usePrStore.setState({ resetEligibleBySession: {}, mergeContinueOptOutBySession: {} });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      localStorage.clear();
    });

    it("is offered whenever the reset control is, and ticked by default (reqs 1, 2)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = renderComposer();
      expect(screen.getByTestId("compact-context-control")).toBeInTheDocument();
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: true }));
    });

    it("is hidden when the shared setting is off (req 11)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: false });
      renderComposer();
      // One switch governs both, so turning it off must take BOTH controls away.
      expect(screen.queryByTestId("compact-context-control")).not.toBeInTheDocument();
      expect(screen.queryByTestId("reset-merged-branch-control")).not.toBeInTheDocument();
    });

    it("is hidden when the session is not reset-eligible (req 3)", () => {
      usePrStore.setState({ resetEligibleBySession: {} });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      renderComposer();
      expect(screen.queryByTestId("compact-context-control")).not.toBeInTheDocument();
    });

    it("is hidden when the backend cannot compact (req 10)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      renderComposer(vi.fn(), nonCompactingAgent);

      expect(screen.queryByTestId("compact-context-control")).not.toBeInTheDocument();
      expect(screen.getByTestId("reset-merged-branch-control")).toBeInTheDocument();
    });

    it("sends compactContext:false after the user unticks it (req 5)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = renderComposer();
      fireEvent.click(screen.getByTestId("compact-context-control"));
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: false }));
    });

    it("leaves the reset intent alone when only the compaction is unticked (req 6)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = renderComposer();
      fireEvent.click(screen.getByTestId("compact-context-control"));
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ compactContext: false, resetMergedBranch: true }),
      );
    });

    it("leaves the compaction intent alone when only the reset is unticked (req 6)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = renderComposer();
      fireEvent.click(screen.getByTestId("reset-merged-branch-control"));
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ compactContext: true, resetMergedBranch: false }),
      );
    });

    it("does not carry the intent at all when the control was not shown", () => {
      usePrStore.setState({ resetEligibleBySession: {} });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = renderComposer();
      typeAndSend();

      expect(onSend.mock.calls[0]![0]).not.toHaveProperty("compactContext");
    });

    it("re-ticks after a send, so the untick applies to that one message (req 5)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      // Must report the send as ACCEPTED: the re-tick sits after the refusal

      const onSend = renderComposer(vi.fn(() => true));

      fireEvent.click(screen.getByTestId("reset-merged-branch-control"));
      fireEvent.click(screen.getByTestId("compact-context-control"));
      typeAndSend();
      typeAndSend();
      expect(onSend.mock.calls[0]![0]).toMatchObject({
        compactContext: false, resetMergedBranch: false,
      });
      expect(onSend.mock.calls[1]![0]).toMatchObject({
        compactContext: true, resetMergedBranch: true,
      });
    });

    it("does not carry an untick into a different session", () => {

      usePrStore.setState({ resetEligibleBySession: { s1: true, s2: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = vi.fn();
      const { rerender } = render(
        <MessageInput
          onSend={onSend} disabled={false} sessionId="s1"
          agents={compactingAgent} activeAgentId="claude"
        />,
      );
      fireEvent.click(screen.getByTestId("compact-context-control"));                
      rerender(
        <MessageInput
          onSend={onSend} disabled={false} sessionId="s2"
          agents={compactingAgent} activeAgentId="claude"
        />,
      );
      typeAndSend();
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: true }));
    });

    /**
     * An eligibility answer landing between the untick and the send.
     *
     * Several server paths recompute eligibility between turns — activation,
     * post-turn, merge-detected, the debounced file-change recompute, and two
     * direct emitters — and `computeResetEligibility` fails closed, so a git
     * read that throws answers `false` for a session that is perfectly
     * eligible. The composer re-armed on the control's visibility, so that
     * `false` re-ticked the box; and if `true` had not arrived back by the time
     * the user pressed Send, the frame omitted `compactContext` altogether,
     * which falls back to the global setting.
     *
     * Both shapes are below. The user's intent must reach the wire in each.
     */
    describe("an eligibility answer between the untick and the send", () => {
      it("keeps the untick when eligibility flickers false and back to true", () => {
        usePrStore.setState({ resetEligibleBySession: { s1: true } });
        useSettingsStore.setState({ autoResetMergedBranch: true });
        const onSend = renderComposer();
        fireEvent.click(screen.getByTestId("compact-context-control")); // untick
        // A recompute fails closed, then the next one succeeds. Nothing the
        // user did, and nothing they can see. (Injected here: the test proves
        // the composer's response to the signal, not that any given production
        // incident produced one.)
        serverSaysEligible(false);
        serverSaysEligible(true);
        typeAndSend();
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: false }));
      });

      it("still carries the untick when the control is away at send time", () => {
        usePrStore.setState({ resetEligibleBySession: { s1: true } });
        useSettingsStore.setState({ autoResetMergedBranch: true });
        const onSend = renderComposer();
        fireEvent.click(screen.getByTestId("compact-context-control")); // untick
        serverSaysEligible(false);
        expect(screen.queryByTestId("compact-context-control")).not.toBeInTheDocument();
        typeAndSend();
        // Omitting the field is not neutral — the server reads an absent
        // `compactContext` as the global setting, which compacts. An opt-out
        // can only say `false`, and `false` can only skip, so it is carried
        // whatever the server currently thinks eligibility is.
        expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: false }));
      });

      it("does not invent an intent when the user never unticked anything", () => {
        usePrStore.setState({ resetEligibleBySession: { s1: true } });
        useSettingsStore.setState({ autoResetMergedBranch: true });
        const onSend = renderComposer();
        serverSaysEligible(false);
        typeAndSend();
        // No control, no opt-out: the server follows the setting, which is how
        // a programmatic continuation behaves (req 13).
        expect(onSend.mock.calls[0]![0]).not.toHaveProperty("compactContext");
        expect(onSend.mock.calls[0]![0]).not.toHaveProperty("resetMergedBranch");
      });
    });

    /**
     * The composer is remounted by more than a reload, and the untick was the
     * ONLY thing on it that did not survive.
     *
     * `AppLayout` renders the chat panel into a Fragment on mobile and a `div`
     * on desktop, so any `isMobile` flip destroys and rebuilds the subtree; and
     * App's own `{(showHarnessOnboarding || !showHomeScreen || showNewSessionView)
     * && …}` wrapper drops the composer whenever `showHomeScreen` turns true.
     * The draft text and the attachment chips came back from their stores, so
     * the composer looked untouched — and a small checkbox had quietly gone
     * back to blue with no signal at all. The reported incident was on a phone,
     * where backgrounded-tab churn makes this routine.
     */
    it("keeps the untick when the composer is remounted under a restored draft", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      const onSend = vi.fn().mockReturnValue(true);
      const composer = (
        <MessageInput
          onSend={onSend} disabled={false} sessionId="s1" focusKey="s1"
          agents={compactingAgent} activeAgentId="claude"
        />
      );
      const { unmount } = render(composer);
      fireEvent.change(
        screen.getByPlaceholderText("Describe what to build... (type @ to attach files)"),
        { target: { value: "next slice of work" } },
      );
      fireEvent.click(screen.getByTestId("compact-context-control")); // untick

      unmount();
      render(composer);

      // What the user sees on the rebuilt composer: their text is back, and so
      // is their choice. Before this fix only the first of those was true.
      const restored = screen.getByPlaceholderText(
        "Describe what to build... (type @ to attach files)",
      ) as HTMLTextAreaElement;
      expect(restored.value).toBe("next slice of work");
      expect(screen.getByTestId("compact-context-control")).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ compactContext: false }));
    });

    it("keeps the untick across a remount (reconnect or reload)", () => {
      usePrStore.setState({ resetEligibleBySession: { s1: true } });
      useSettingsStore.setState({ autoResetMergedBranch: true });
      renderComposer();
      // Untick BOTH, so the still-ticked reset does not optimistically clear
      // eligibility and take the row off screen — this test is about the row
      // still being there, with the user's choice on it.
      fireEvent.click(screen.getByTestId("reset-merged-branch-control"));
      fireEvent.click(screen.getByTestId("compact-context-control"));
      // A reload remounts the composer AND empties the store, leaving
      // localStorage as the only record of the choice.
      cleanup();
      usePrStore.setState({ mergeContinueOptOutBySession: {} });
      const onSend = renderComposer(vi.fn().mockReturnValue(true));
      expect(screen.getByTestId("compact-context-control")).toHaveAttribute("aria-pressed", "false");
      typeAndSend();
      expect(onSend.mock.calls[0]![0]).toMatchObject({
        compactContext: false, resetMergedBranch: false,
      });
      // …and it applies to THAT message only (req 5). Clearing has to reach the
      // mounted composer even though the opt-out came only from localStorage:
      // dropping the storage key alone left the restored value on screen and
      // the untick went on governing every later message in the session.
      expect(screen.getByTestId("compact-context-control")).toHaveAttribute("aria-pressed", "true");
      typeAndSend();
      expect(onSend.mock.calls[1]![0]).toMatchObject({
        compactContext: true, resetMergedBranch: true,
      });
    });

  });

  describe("narrow composer row (docs/260)", () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    function stubComposerWidth(width: number) {
      vi.stubGlobal("ResizeObserver", ResizeObserverStub);
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => width,
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      // @ts-expect-error -- restoring the jsdom default (always 0)
      delete HTMLElement.prototype.clientWidth;
    });

    const agents = [
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        hasRunnableModels: true,
        models: ["claude-opus-5"],
        eligibleModels: [
          {
            serviceId: "anthropic",
            serviceName: "Anthropic",
            billingMode: "sub" as const,
            modelId: "claude-opus-5",
            label: "Opus 5",
            canonicalModelKey: "claude-opus-5",
          },
        ],
        supportsReview: true,
        supportedPermissionModes: ["plan", "guarded", "auto"] as PermissionMode[],
      },
    ];

    function renderComposer(width: number, props: Record<string, unknown> = {}) {
      stubComposerWidth(width);
      return render(
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          agents={agents}
          activeAgentId="claude"
          onAgentChange={vi.fn()}
          onModelChange={vi.fn()}
          onReasoningChange={vi.fn()}
          onPermissionModeChange={vi.fn()}
          modelInfo={{ model: "claude-opus-5", contextWindowTokens: 200000 }}
          contextTokens={24000}
          hasActiveSession
          {...props}
        />,
      );
    }

    it("collapses the settings into one control below 700px (req 3)", () => {
      renderComposer(520);
      expect(screen.getByTestId("composer-settings-trigger")).toBeInTheDocument();

      expect(screen.queryByTestId("harness-trigger")).toBeNull();
      expect(screen.queryByTestId("model-trigger")).toBeNull();
      expect(screen.queryByTestId("reasoning-trigger")).toBeNull();

      expect(screen.getByTestId("permission-mode-selector")).toBeInTheDocument();
    });

    it("leaves the row exactly as it was at 700px and above (req 3)", () => {
      renderComposer(760);
      expect(screen.queryByTestId("composer-settings-trigger")).toBeNull();
      expect(screen.getByTestId("harness-trigger")).toBeInTheDocument();
      expect(screen.getByTestId("model-trigger")).toBeInTheDocument();
    });

    it("keys off the COMPOSER's width, not the window's (req 2)", () => {

      mockMatchMedia(false);
      renderComposer(520);
      expect(screen.getByTestId("composer-settings-trigger")).toBeInTheDocument();
    });

    it("puts Send outside the clipping group so nothing can displace it (req 1)", () => {
      renderComposer(320);
      const send = screen.getByTestId("send-button");
      const group = document.querySelector(".overflow-hidden.min-w-0");
      expect(group).not.toBeNull();
      // Send is a SIBLING of the group, never inside it — that, and `shrink-0`,

      expect(group!.contains(send)).toBe(false);
      expect(send.className).toContain("shrink-0");
    });

    it("keeps Stop and Send both reachable while a turn runs with live steering", () => {
      renderComposer(320, { isLoading: true, onInterrupt: vi.fn(), liveSteeringActive: true });
      const group = document.querySelector(".overflow-hidden.min-w-0");
      for (const id of ["stop-button", "send-button"]) {
        const el = screen.getByTestId(id);
        expect(group!.contains(el)).toBe(false);
        expect(el.className).toContain("shrink-0");
      }
    });

    it("shows the context ring without its figures (req 15)", () => {
      renderComposer(520);
      expect(screen.getByTestId("context-dial")).toBeInTheDocument();
      expect(screen.queryByTestId("context-dial-label")).toBeNull();
      expect(screen.queryByTestId("context-dial-cost")).toBeNull();
    });

    it("keeps the attach button in the row rather than in the menu (req 16)", () => {
      renderComposer(320);
      expect(screen.getByLabelText("Add files")).toBeInTheDocument();
    });

    it("pins the wide row's actions too, clipping its labels instead (req 1, req 8)", () => {

      // way, rather than the left, because in THIS row the mic is on the left

      useSettingsStore.setState({ voiceInputEnabled: true });
      renderComposer(760, { isLoading: true, onInterrupt: vi.fn(), liveSteeringActive: true });
      const group = screen.getByTestId("wide-row-clip-group");
      expect(group.className).toContain("min-w-0");
      expect(group.className).toContain("overflow-hidden");
      for (const id of ["stop-button", "send-button"]) {
        expect(group.contains(screen.getByTestId(id))).toBe(false);
      }

      expect(group.contains(screen.getByTestId("mic-button"))).toBe(false);

      expect(group.contains(screen.getByTestId("model-trigger"))).toBe(true);
      expect(group.contains(screen.getByTestId("harness-trigger"))).toBe(true);
    });

    it("names a non-default permission mode by the mode alone (req 17)", () => {
      renderComposer(760, { permissionMode: "guarded" });
      const mode = screen.getByTestId("permission-mode-selector");
      expect(mode).toHaveTextContent("Guarded");
      expect(mode).not.toHaveTextContent("Guarded mode");
    });

    /**
     * The clipping groups above are what makes this a guard rather than a style
     * preference: their content box hugs the buttons, so ANY focus indicator
     * painted outside a control's border box — the UA's own outline, or a
     * non-inset Tailwind `ring-*` — is shaved off on all four sides, and the
     * control reads as having a broken selected state. It is silent to every
     * other test here, because the markup is correct and only the paint is wrong.
     *
     * Asserted on the whole row, not only on the controls the group currently
     * contains: which of them sit inside it is a layout detail that has already
     * changed once (req 3 moved four of them into one anchor), and a row where
     * one button's ring is a different shape from its neighbours' is its own
     * defect.
     */
    it("draws every toolbar control's focus ring inside its border box", () => {
      const inset = INSET_FOCUS_RING.split(" ");

      // Reasoning is absent from this list because the fixture's agent has no

      renderComposer(760, { permissionMode: "guarded" });
      for (const id of [
        "context-dial",
        "harness-trigger",
        "model-trigger",
        "permission-mode-selector",
      ]) {
        const control = screen.getByTestId(id);
        for (const cls of inset) {
          expect(`${id}: ${control.className}`).toContain(cls);
        }
      }
      cleanup();

      renderComposer(520);
      for (const id of ["composer-settings-trigger", "context-dial"]) {
        const control = screen.getByTestId(id);
        for (const cls of inset) {
          expect(`${id}: ${control.className}`).toContain(cls);
        }
      }
    });
  });

});
