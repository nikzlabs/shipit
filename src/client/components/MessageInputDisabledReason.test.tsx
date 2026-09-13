

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { VoiceInputApi } from "../voice/use-voice-input.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";

const startRecording = vi.hoisted(() => vi.fn());
const cancelRecording = vi.hoisted(() => vi.fn());

const voiceOptions = vi.hoisted(() => [] as { enabled: boolean }[]);

vi.mock("../voice/use-voice-input.js", () => ({
  useVoiceInput: (opts: { enabled: boolean }): VoiceInputApi => {
    voiceOptions.push(opts);
    return {
      state: "idle",
      elapsedMs: 0,
      errorMessage: null,
      cleanupWarning: null,
      canRetryTranscription: false,
      startRecording,
      stopRecording: () => {},
      cancelRecording,
      retryTranscription: () => {},
      onTranscript: () => () => {},
      dismissError: () => {},
      dismissCleanupWarning: () => {},
    };
  },
}));

const { MessageInput } = await import("./MessageInput/MessageInput.js");

const REASON = "Add a model provider to start chatting";
const LIVE_PLACEHOLDER = "Describe what to build... (type @ to attach files)";
const DRAFT_KEY_PREFIX = "shipit-draft-message:";

afterEach(cleanup);

beforeEach(() => {
  startRecording.mockReset();
  cancelRecording.mockReset();
  voiceOptions.length = 0;
  localStorage.clear();
  useSessionStore.setState({ prefillText: undefined, quoteReplyText: undefined });
  useSettingsStore.setState({ voiceInputEnabled: false });
  useUiStore.setState({ quickCaptureAutoMic: false });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe("MessageInput disabledReason (docs/257 req 3)", () => {
  it("is not typeable and shows the reason as its placeholder", () => {
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />);
    const textarea = screen.getByPlaceholderText(REASON);
    expect(textarea).toBeDisabled();
    expect(screen.queryByPlaceholderText(LIVE_PLACEHOLDER)).toBeNull();
  });

  it("cannot attach files", () => {
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />);
    expect(screen.getByLabelText("Add files")).toBeDisabled();
  });

  it("cannot dictate — the mic is not offered", () => {
    useSettingsStore.setState({ voiceInputEnabled: true });
    const { rerender } = render(
      <MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />,
    );

    expect(screen.queryByTestId("mic-button")).toBeNull();

    rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    expect(screen.getByTestId("mic-button")).toBeInTheDocument();
  });

  it("locks the harness, model and reasoning pickers", () => {

    const agents = [
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        hasRunnableModels: false,
        models: [],
        supportsReview: true,
        reasoning: { label: "Effort", options: [{ value: "low", label: "Low" }] },
      },
    ];
    const props = {
      onSend: vi.fn(),
      disabled: false,
      agents,
      activeAgentId: "claude" as const,
      onAgentChange: vi.fn(),
      onModelChange: vi.fn(),
      onReasoningChange: vi.fn(),
    };
    const { rerender } = render(<MessageInput {...props} disabledReason={REASON} />);
    expect(screen.getByTestId("harness-trigger")).toBeDisabled();
    expect(screen.getByTestId("model-trigger")).toBeDisabled();
    expect(screen.getByTestId("reasoning-trigger")).toBeDisabled();

    rerender(<MessageInput {...props} />);
    expect(screen.getByTestId("harness-trigger")).not.toBeDisabled();
    expect(screen.getByTestId("reasoning-trigger")).not.toBeDisabled();

    // 14 answers it: a picker with no options never opens, so with no runnable

    expect(screen.getByTestId("model-trigger")).toBeDisabled();
  });

  it("does not auto-start recording when Quick Capture was opened by the voice hotkey", () => {

    useSettingsStore.setState({ voiceInputEnabled: true });
    useUiStore.setState({ quickCaptureAutoMic: true });
    render(
      <MessageInput
        surface="overlay"
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        disabledReason={REASON}
      />,
    );
    expect(startRecording).not.toHaveBeenCalled();

    expect(useUiStore.getState().quickCaptureAutoMic).toBe(false);
  });

  it("still arms the mic when the chat is runnable", () => {
    useSettingsStore.setState({ voiceInputEnabled: true });
    useUiStore.setState({ quickCaptureAutoMic: true });
    render(<MessageInput surface="overlay" onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    expect(startRecording).toHaveBeenCalled();
  });

  it("does not ingest a pasted image", () => {
    const paste = (placeholder: string) => {
      const file = new File(["x"], "shot.png", { type: "image/png" });
      fireEvent.paste(screen.getByPlaceholderText(placeholder), {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => file }],
          getData: () => "",
        },
      });
    };
    render(
      <MessageInput surface="overlay" onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />,
    );
    paste(REASON);

    expect(screen.queryByTestId("file-upload-chips")).toBeNull();

    cleanup();
    render(<MessageInput surface="overlay" onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    paste(LIVE_PLACEHOLDER);
    expect(screen.getByTestId("file-upload-chips")).toBeInTheDocument();
  });

  it("renders the textarea empty so a retained draft cannot hide the reason", () => {

    // the user cannot send, sitting on top of the explanation of why.
    localStorage.setItem(`${DRAFT_KEY_PREFIX}session-1`, "half-written thought");
    render(
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        disabledReason={REASON}
        focusKey="session-1"
      />,
    );
    const textarea = screen.getByPlaceholderText(REASON) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    expect(localStorage.getItem(`${DRAFT_KEY_PREFIX}session-1`)).toBe("half-written thought");
  });

  it("refuses to send that retained draft", () => {
    const onSend = vi.fn().mockReturnValue(true);
    localStorage.setItem(`${DRAFT_KEY_PREFIX}session-1`, "half-written thought");
    render(
      <MessageInput
        onSend={onSend}
        disabled={false}
        disabledReason={REASON}
        focusKey="session-1"
      />,
    );
    const send = screen.getByLabelText("Send message");
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns the voice hook off, not just the mic button", () => {

    // cannot be sent. This asserts the mechanism, since the listeners are

    useSettingsStore.setState({ voiceInputEnabled: true });
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />);
    expect(voiceOptions.at(-1)?.enabled).toBe(false);

    cleanup();
    voiceOptions.length = 0;
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    expect(voiceOptions.at(-1)?.enabled).toBe(true);
  });

  it("aborts a recording that was already running when the install went dead", () => {

    useSettingsStore.setState({ voiceInputEnabled: true });
    const { rerender } = render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    expect(cancelRecording).not.toHaveBeenCalled();
    rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} />);
    expect(cancelRecording).toHaveBeenCalled();
  });

  it("defers an external prefill instead of consuming it into the hidden draft", () => {

    localStorage.setItem(`${DRAFT_KEY_PREFIX}session-1`, "half-written thought");
    const { rerender } = render(
      <MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} focusKey="session-1" />,
    );
    useSessionStore.getState().setPrefillText("seeded prompt");

    expect((screen.getByPlaceholderText(REASON) as HTMLTextAreaElement).value).toBe("");
    expect(useSessionStore.getState().prefillText).toBe("seeded prompt");

    rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-1" />);
    expect((screen.getByPlaceholderText(LIVE_PLACEHOLDER) as HTMLTextAreaElement).value)
      .toBe("seeded prompt");
    expect(useSessionStore.getState().prefillText).toBeUndefined();
  });

  it("defers a quote-reply for the same reason", () => {
    const { rerender } = render(
      <MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} disabledReason={REASON} focusKey="session-1" />,
    );
    useSessionStore.getState().setQuoteReplyText("> quoted line");

    expect((screen.getByPlaceholderText(REASON) as HTMLTextAreaElement).value).toBe("");
    expect(useSessionStore.getState().quoteReplyText).toBe("> quoted line");

    rerender(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} focusKey="session-1" />);
    expect((screen.getByPlaceholderText(LIVE_PLACEHOLDER) as HTMLTextAreaElement).value)
      .toContain("> quoted line");
  });

  it("leaves every affordance live when no reason is set", () => {
    // The complement: this prop must not change today's behaviour when unset.
    useSettingsStore.setState({ voiceInputEnabled: true });
    render(<MessageInput onSend={vi.fn().mockReturnValue(true)} disabled={false} />);
    const textarea = screen.getByPlaceholderText(LIVE_PLACEHOLDER);
    expect(textarea).not.toBeDisabled();
    expect(screen.getByLabelText("Add files")).not.toBeDisabled();
  });
});
