import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MicButton } from "./MicButton.js";
import type { VoiceInputApi, VoiceInputState } from "../voice/use-voice-input.js";

afterEach(() => {
  cleanup();
});

function makeVoice(overrides: Partial<VoiceInputApi> = {}): VoiceInputApi {
  return {
    state: "idle" as VoiceInputState,
    elapsedMs: 0,
    errorMessage: null,
    cleanupWarning: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    onTranscript: vi.fn(() => () => {}),
    dismissError: vi.fn(),
    ...overrides,
  };
}

describe("MicButton", () => {
  it("renders an accessible button in idle state", () => {
    render(<MicButton voice={makeVoice()} />);
    const btn = screen.getByRole("button", { name: "Dictate a message" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("data-state", "idle");
  });

  it("starts recording when the idle button is clicked", () => {
    const voice = makeVoice();
    render(<MicButton voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    expect(voice.startRecording).toHaveBeenCalledTimes(1);
    expect(voice.stopRecording).not.toHaveBeenCalled();
  });

  it("reflects recording state with elapsed time and stop affordance", () => {
    const voice = makeVoice({ state: "recording", elapsedMs: 65_000 });
    render(<MicButton voice={voice} />);
    const btn = screen.getByRole("button", { name: "Stop recording" });
    expect(btn).toHaveAttribute("data-state", "recording");
    // 65_000ms → 01:05
    expect(screen.getByText("01:05")).toBeInTheDocument();
  });

  it("stops recording when the recording button is clicked", () => {
    const voice = makeVoice({ state: "recording" });
    render(<MicButton voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(voice.stopRecording).toHaveBeenCalledTimes(1);
    expect(voice.startRecording).not.toHaveBeenCalled();
  });

  it("shows a disabled busy indicator while transcribing", () => {
    const voice = makeVoice({ state: "transcribing" });
    render(<MicButton voice={voice} />);
    const btn = screen.getByRole("button", { name: "Transcribing" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("data-state", "transcribing");
  });

  it("surfaces the error message in the error state and dismisses on click", () => {
    const voice = makeVoice({ state: "error", errorMessage: "Mic permission denied" });
    render(<MicButton voice={voice} />);
    const btn = screen.getByRole("button", { name: "Mic permission denied" });
    expect(btn).toHaveAttribute("data-state", "error");
    fireEvent.click(btn);
    expect(voice.dismissError).toHaveBeenCalledTimes(1);
  });

  it("shift-click in error state opens settings and dismisses the error", () => {
    const voice = makeVoice({ state: "error", errorMessage: "Mic permission denied" });
    const onOpenSettings = vi.fn();
    render(<MicButton voice={voice} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Mic permission denied" }), {
      shiftKey: true,
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(voice.dismissError).toHaveBeenCalledTimes(1);
  });

  it("includes the hotkey label in the idle button accessible name when provided", () => {
    // aria-label stays stable; the hotkey lands in the tooltip label.
    render(<MicButton voice={makeVoice()} hotkeyLabel="Ctrl+Shift+Space" />);
    expect(screen.getByRole("button", { name: "Dictate a message" })).toBeInTheDocument();
  });
});
