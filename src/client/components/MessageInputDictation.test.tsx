/**
 * docs/144 — the composer's dictation flag.
 *
 * The transcript itself is already covered by `voice/insert-transcript.test.ts`
 * (where the words land). What's under test here is the *provenance* signal:
 * a message that contains dictated text must ship `dictated: true` so the
 * server can tell the agent the words came out of speech-to-text, and a typed
 * message must not.
 *
 * `useVoiceInput` is faked at the module boundary so a test can push a
 * transcript through the same `onTranscript` subscription the real hook uses —
 * no mic, no fetch, no timers.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { VoiceInputApi } from "../voice/use-voice-input.js";

/** Subscribers registered by the component under test. */
const subscribers = new Set<(text: string) => void>();

vi.mock("../voice/use-voice-input.js", () => ({
  useVoiceInput: (): VoiceInputApi => ({
    state: "idle",
    elapsedMs: 0,
    errorMessage: null,
    cleanupWarning: null,
    canRetryTranscription: false,
    startRecording: () => {},
    stopRecording: () => {},
    cancelRecording: () => {},
    retryTranscription: () => {},
    onTranscript: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    dismissError: () => {},
    dismissCleanupWarning: () => {},
  }),
}));

const { MessageInput } = await import("./MessageInput.js");

/** Push a transcript through every live subscription, as the real hook does. */
function dictate(text: string) {
  act(() => {
    for (const cb of subscribers) cb(text);
  });
}

const PLACEHOLDER = "Describe what to build... (type @ to attach files)";

afterEach(() => {
  cleanup();
  subscribers.clear();
});

beforeEach(() => {
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

describe("MessageInput dictation provenance (docs/144)", () => {
  it("omits `dictated` for a typed message", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
      target: { value: "fix the auth bug" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).not.toHaveProperty("dictated");
  });

  it("marks a dictated message", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    dictate("fix the off bug");
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "fix the off bug", dictated: true }),
    );
  });

  it("marks a message that mixes typing and dictation", () => {
    // The point of the hint is transcription artifacts, and a partly-dictated
    // message has them just the same.
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: "in auth.ts," } });
    dictate("fix the off bug");
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(onSend.mock.calls[0][0]).toMatchObject({ dictated: true });
  });

  it("does not carry the flag onto the NEXT message", () => {
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    dictate("first one");
    fireEvent.click(screen.getByLabelText("Send message"));

    const textarea = screen.getByPlaceholderText(PLACEHOLDER);
    fireEvent.change(textarea, { target: { value: "second one" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0][0]).toMatchObject({ dictated: true });
    expect(onSend.mock.calls[1][0]).not.toHaveProperty("dictated");
  });

  it("drops the flag when the user clears the draft and types instead", () => {
    // Dictate, think better of it, select-all-delete, type it by hand. Nothing
    // spoken survives into the sent text, so the hint would be a lie.
    const onSend = vi.fn();
    render(<MessageInput onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(PLACEHOLDER);
    dictate("scrap this");
    fireEvent.change(textarea, { target: { value: "" } });
    fireEvent.change(textarea, { target: { value: "typed from scratch" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(onSend.mock.calls[0][0]).not.toHaveProperty("dictated");
  });
});
