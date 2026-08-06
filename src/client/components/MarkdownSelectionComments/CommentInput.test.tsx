import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CommentInput } from "./CommentInput.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { VoiceInputApi } from "../../voice/use-voice-input.js";

/**
 * A controllable stand-in for the voice hook: the component under test only
 * ever sees a transcript arrive through `onTranscript`, so the fake exposes an
 * `emit` to fire one on demand.
 */
const fakeVoice = {
  subscribers: new Set<(text: string) => void>(),
  state: "idle" as VoiceInputApi["state"],
  cancelled: 0,
  emit(text: string) {
    for (const cb of this.subscribers) cb(text);
  },
  reset() {
    this.subscribers.clear();
    this.state = "idle";
    this.cancelled = 0;
  },
};

vi.mock("../../voice/use-voice-input.js", () => ({
  useVoiceInput: (): VoiceInputApi => ({
    state: fakeVoice.state,
    elapsedMs: 0,
    errorMessage: null,
    cleanupWarning: null,
    canRetryTranscription: false,
    startRecording: () => {},
    stopRecording: () => {},
    cancelRecording: () => { fakeVoice.cancelled += 1; },
    retryTranscription: () => {},
    onTranscript: (cb: (text: string) => void) => {
      fakeVoice.subscribers.add(cb);
      return () => fakeVoice.subscribers.delete(cb);
    },
    dismissError: () => {},
    dismissCleanupWarning: () => {},
  }),
}));

beforeEach(() => {
  fakeVoice.reset();
  useSettingsStore.setState({ voiceInputEnabled: true });
});
afterEach(cleanup);

function renderInput(overrides?: { onSubmit?: (t: string) => void; onCancel?: () => void }) {
  return render(
    <CommentInput
      onSubmit={overrides?.onSubmit ?? (() => {})}
      onCancel={overrides?.onCancel ?? (() => {})}
    />,
  );
}

describe("CommentInput voice dictation", () => {
  it("hides the mic when voice input is disabled", () => {
    useSettingsStore.setState({ voiceInputEnabled: false });
    renderInput();
    expect(screen.queryByTestId("mic-button")).not.toBeInTheDocument();
  });

  it("shows the mic when voice input is enabled", () => {
    renderInput();
    expect(screen.getByTestId("mic-button")).toBeInTheDocument();
  });

  it("splices a dictated transcript into the comment text", () => {
    renderInput();
    act(() => fakeVoice.emit("Rename this section."));
    expect(screen.getByRole("textbox")).toHaveValue("Rename this section.");
  });

  it("appends a second dictation after typed text without running words together", () => {
    renderInput();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Typed part." } });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    act(() => fakeVoice.emit("Dictated part."));
    expect(textarea).toHaveValue("Typed part. Dictated part.");
  });

  it("enables the Add button once a dictated transcript arrives", () => {
    renderInput();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    act(() => fakeVoice.emit("Looks good."));
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("submits dictated text", () => {
    const onSubmit = vi.fn();
    renderInput({ onSubmit });
    act(() => fakeVoice.emit("Ship it."));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSubmit).toHaveBeenCalledWith("Ship it.");
  });

  it("cancels the recording — not the comment — when Escape is pressed mid-dictation", () => {
    const onCancel = vi.fn();
    fakeVoice.state = "recording";
    renderInput({ onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fakeVoice.cancelled).toBe(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still cancels the comment on Escape when not recording", () => {
    const onCancel = vi.fn();
    renderInput({ onCancel });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
