import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageInput } from "./MessageInput.js";
import type { PermissionMode } from "../../server/shared/types.js";
import { useSessionStore } from "../stores/session-store.js";

afterEach(cleanup);

/**
 * Stub `window.matchMedia` so `useIsMobile()` returns the desired value.
 * Pass `true` to simulate a mobile viewport.
 */
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
  // Default to desktop so existing tests keep their previous behavior.
  mockMatchMedia(false);
});

describe("MessageInput", () => {
  describe("basic functionality", () => {
    it("renders the input textarea and send button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByPlaceholderText("Describe what to build... (type @ to attach files)")).toBeInTheDocument();
      expect(screen.getByLabelText("Send message")).toBeInTheDocument();
    });

    it("renders the add files button", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      expect(screen.getByLabelText("Add files")).toBeInTheDocument();
    });

    it("sends text message on submit", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "Hello Claude" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello Claude" }));
    });

    it("sends text on Enter (without Shift)", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "test" }));
    });

    it("does NOT send on Enter when on a mobile viewport", () => {
      // On mobile, the on-screen keyboard's return key should insert a newline
      // rather than fire-and-forget the message — matches native chat-app
      // behavior. The user sends via the explicit send button instead.
      mockMatchMedia(true);
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "test" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSend).not.toHaveBeenCalled();
    });

    it("still sends via the send button on a mobile viewport", () => {
      mockMatchMedia(true);
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "hello mobile" } });
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: "hello mobile" }));
    });

    it("does not send empty messages", () => {
      const onSend = vi.fn();
      render(<MessageInput onSend={onSend} disabled={false} />);
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(onSend).not.toHaveBeenCalled();
    });

    it("disables send button when disabled prop is true", () => {
      render(<MessageInput onSend={vi.fn()} disabled={true} />);
      expect(screen.getByLabelText("Send message")).toBeDisabled();
    });
  });

  describe("permission mode selector", () => {
    const claudeWithModes = [{
      id: "claude", name: "Claude Code", installed: true, authConfigured: true,
      models: ["claude-sonnet-4"], supportsReview: true,
      supportedPermissionModes: ["auto", "plan", "guarded"] as PermissionMode[],
    }];

    it("renders permission mode selector when onPermissionModeChange is provided and the agent supports modes", () => {
      render(
        <MessageInput
          onSend={vi.fn()}
          disabled={false}
          onPermissionModeChange={vi.fn()}
          agents={claudeWithModes}
          activeAgentId="claude"
        />,
      );
      expect(screen.getByTestId("permission-mode-selector")).toBeInTheDocument();
    });

    it("does not render permission mode selector when onPermissionModeChange is not provided", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} agents={claudeWithModes} activeAgentId="claude" />);
      expect(screen.queryByTestId("permission-mode-selector")).not.toBeInTheDocument();
    });

    it("hides the selector for an agent that advertises no permission modes", () => {
      render(
        <MessageInput
          onSend={vi.fn()}
          disabled={false}
          onPermissionModeChange={vi.fn()}
          agents={[{ id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["gpt-5"], supportsReview: false, supportedPermissionModes: [] }]}
          activeAgentId="codex"
        />,
      );
      expect(screen.queryByTestId("permission-mode-selector")).not.toBeInTheDocument();
    });
  });

  describe("model agent selector", () => {
    it("renders model selector when onAgentChange is provided", () => {
      render(
        <MessageInput
          onSend={vi.fn()}
          disabled={false}
          onAgentChange={vi.fn()}
          agents={[{ id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet-4"], supportsReview: true }]}
          modelInfo={{ model: "Opus 4.6", contextWindowTokens: 200000 }}
        />,
      );
      expect(screen.getByTestId("model-agent-selector")).toBeInTheDocument();
      expect(screen.getByText("Opus 4.6")).toBeInTheDocument();
    });
  });

  describe("drag and drop", () => {
    it("shows drop zone overlay when dragging over", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.px-4")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
    });

    it("hides drop zone overlay when dragging out", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const container = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)").closest("div.px-4")!;
      fireEvent.dragEnter(container, { dataTransfer: { files: [] } });
      expect(screen.getByText("Drop files here")).toBeInTheDocument();
      fireEvent.dragLeave(container, { dataTransfer: { files: [] } });
      expect(screen.queryByText("Drop files here")).not.toBeInTheDocument();
    });
  });

  describe("focus reclaim on blur", () => {
    // Regression: the textarea used to reclaim focus after ANY blur with
    // relatedTarget=null and activeElement=body. That blew away in-progress
    // text selections — when the user mousedowned on a chat message (non-
    // focusable text), the textarea blurred, focus jumped to body, the
    // requestAnimationFrame fired, and the textarea grabbed focus back,
    // collapsing the selection. The intent was only to defend against
    // cross-origin iframe focus theft, so we now only reclaim when
    // activeElement is an IFRAME.
    it("does NOT reclaim focus when blur leaves activeElement=body", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);

      // Simulate a blur with relatedTarget=null while activeElement is body
      // (the natural state when the user mousedowns on non-focusable text).
      textarea.blur();
      fireEvent.blur(textarea, { relatedTarget: null });
      expect(document.activeElement).toBe(document.body);

      // Wait for the rAF inside handleBlur to run.
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      // Textarea should NOT have stolen focus back — selection-cancelling bug fixed.
      expect(document.activeElement).toBe(document.body);
    });

    it("DOES reclaim focus when blur leaves activeElement=iframe (focus theft)", async () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
      textarea.focus();
      focusSpy.mockClear();

      // Inject an iframe and move focus into it to simulate cross-origin focus theft.
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      iframe.focus();
      // Some test DOMs don't actually shift activeElement on iframe.focus(); coerce
      // it via Object.defineProperty so the assertion under test runs against the
      // expected state.
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => iframe });
      fireEvent.blur(textarea, { relatedTarget: null });

      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      // The handler should have called textarea.focus() to reclaim focus from
      // the iframe (no user click on the iframe preceded the focus loss).
      expect(focusSpy).toHaveBeenCalled();
      // (Reset the property override so other tests aren't affected.)
      delete (document as unknown as Record<string, unknown>).activeElement;
      iframe.remove();
    });

    it("does NOT reclaim focus when the user clicked the iframe (canvas/WebGL games)", async () => {
      // Regression: when the user clicks the preview iframe — e.g. to play a
      // WebGL/Canvas game where the canvas does not natively grab focus — the
      // browser focuses the iframe element and blurs the textarea. The old
      // reclaim logic yanked focus back to the textarea, so subsequent keystrokes
      // typed into the chat input instead of reaching the game. The fix uses a
      // capture-phase pointerdown listener to detect intentional iframe clicks
      // and skip the reclaim in that case.
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, "focus");
      textarea.focus();
      focusSpy.mockClear();

      // Simulate the user clicking on a preview iframe.
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      iframe.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

      // ...which then steals focus from the textarea (same DOM path as the
      // focus-theft test above).
      iframe.focus();
      Object.defineProperty(document, "activeElement", { configurable: true, get: () => iframe });
      fireEvent.blur(textarea, { relatedTarget: null });

      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      // Reclaim must NOT fire — focus stays in the iframe so the game receives
      // subsequent keystrokes.
      expect(focusSpy).not.toHaveBeenCalled();

      delete (document as unknown as Record<string, unknown>).activeElement;
      iframe.remove();
    });
  });

  describe("auto-focus on session change", () => {
    // Helper: wait two animation frames so the rAF inside the focus block fires.
    const waitForFocusRaf = async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    };

    it("focuses the textarea when focusKey changes on desktop", async () => {
      const { rerender } = render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      // Move focus elsewhere so we can observe whether the textarea reclaims it.
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
      expect(document.activeElement).toBe(document.body);

      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-B" />);
      await waitForFocusRaf();

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      expect(document.activeElement).toBe(textarea);
    });

    it("does NOT focus the textarea when focusKey changes on a mobile viewport", async () => {
      // On mobile, focusing the textarea pops the on-screen keyboard. Switching
      // sessions shouldn't summon the keyboard — the user can tap to type when
      // they actually want to.
      mockMatchMedia(true);
      const { rerender } = render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
      expect(document.activeElement).toBe(document.body);

      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-B" />);
      await waitForFocusRaf();

      expect(document.activeElement).toBe(document.body);
    });

    it("does not run the chat focusKey path for overlay surface changes", async () => {
      const { rerender } = render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="overlay-A" surface="overlay" />);
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();

      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="overlay-B" surface="overlay" />);
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
      render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="overlay" surface="overlay" />);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));

      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
      expect(useSessionStore.getState().prefillText).toBe("send this to chat");
    });

    it("hides the context dial even when model info is present", () => {
      render(
        <MessageInput
          onSend={vi.fn()}
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
      render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      expect(textarea.value).toBe("draft for A");
    });

    it("saves typed text under the active session's focusKey", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "in progress" } });
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("in progress");
    });

    it("swaps drafts when focusKey changes", () => {
      localStorage.setItem("shipit-draft-message:session-B", "B's draft");
      const { rerender } = render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;

      // Type into A.
      fireEvent.change(textarea, { target: { value: "A's draft" } });
      expect(textarea.value).toBe("A's draft");

      // Switch to B — A's draft persists, B's draft loads.
      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-B" />);
      expect(textarea.value).toBe("B's draft");
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("A's draft");

      // Switch back to A — A's draft is recovered.
      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      expect(textarea.value).toBe("A's draft");
    });

    it("shows empty input when switching to a session with no saved draft", () => {
      const { rerender } = render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "A's draft" } });

      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-fresh" />);
      expect(textarea.value).toBe("");
    });

    it("preserves typed text while focusKey is held stable across re-renders (new-session graduation)", () => {
      // Regression: on the /{slug}/new view, claimSession() resolves a few
      // seconds after mount and sets sessionId in the store. App.tsx must
      // keep MessageInput's focusKey="new" across that resolution — otherwise
      // focusKey flips from "new" to the real session ID mid-type and the
      // draft-swap logic loads the (empty) draft for the brand-new session,
      // wiping the user's text. This test pins the contract: a stable focusKey
      // must NOT clear the textarea on re-render, even when other props change.
      const { rerender } = render(
        <MessageInput onSend={vi.fn()} disabled={true} focusKey="new" />,
      );
      const textarea = screen.getByPlaceholderText(
        "Describe what to build... (type @ to attach files)",
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "hello world" } });
      expect(textarea.value).toBe("hello world");

      // Simulate App.tsx re-rendering after claimSession resolves: other props
      // change (e.g. `disabled` flips as the WS opens) but focusKey stays "new".
      rerender(<MessageInput onSend={vi.fn()} disabled={false} focusKey="new" />);
      expect(textarea.value).toBe("hello world");
    });

    it("clears the saved draft after sending", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} focusKey="session-A" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "ship it" } });
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBe("ship it");
      fireEvent.click(screen.getByLabelText("Send message"));
      expect(localStorage.getItem("shipit-draft-message:session-A")).toBeNull();
    });
  });

  describe("file picker", () => {
    it("has a hidden file input that accepts all file types", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} />);
      const fileInput = screen.getByTestId("file-input") as HTMLInputElement;
      expect(fileInput.type).toBe("file");
      expect(fileInput.accept).toBe(""); // accepts all file types
      expect(fileInput.multiple).toBe(true);
    });

    it("buffers attached files in overlay surface and surfaces them as deferredFiles on send", () => {
      const onSend = vi.fn();
      // surface="overlay" → MessageInput buffers raw files locally (quick-capture path).
      render(<MessageInput onSend={onSend} disabled={false} surface="overlay" />);
      const fileInput = screen.getByTestId("file-input");

      const textFile = new File(["hello"], "doc.txt", { type: "text/plain" });
      const pngFile = new File(["img"], "photo.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [textFile, pngFile] } });

      // Send carries the raw Files as deferredFiles (uploadRefs empty since no session).
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
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
      expect(screen.getByTestId("skill-autocomplete")).toBeInTheDocument();
      expect(screen.getAllByTestId("skill-autocomplete-item")).toHaveLength(2);
    });

    it("filters skills by the query after the slash", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/dep", selectionStart: 4 } });
      const items = screen.getAllByTestId("skill-autocomplete-item");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("/deploy");
    });

    it("inserts the selected skill name with a trailing space", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
      fireEvent.click(screen.getByText("/review"));
      expect(textarea.value).toBe("/review ");
    });

    it("does not open when the slash is not at the start", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "hello /deploy", selectionStart: 13 } });
      expect(screen.queryByTestId("skill-autocomplete")).not.toBeInTheDocument();
    });

    it("does not open when no skills are available", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={[]} />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/", selectionStart: 1 } });
      expect(screen.queryByTestId("skill-autocomplete")).not.toBeInTheDocument();
    });

    it("opens on a leading slash for Codex but displays the $ token", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} activeAgentId="codex" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)");
      fireEvent.change(textarea, { target: { value: "/dep", selectionStart: 4 } });
      const items = screen.getAllByTestId("skill-autocomplete-item");
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent("$deploy");
    });

    it("inserts $name for Codex instead of /name", () => {
      render(<MessageInput onSend={vi.fn()} disabled={false} skills={skills} activeAgentId="codex" />);
      const textarea = screen.getByPlaceholderText("Describe what to build... (type @ to attach files)") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
      fireEvent.click(screen.getByText("$review"));
      expect(textarea.value).toBe("$review ");
    });
  });

});
