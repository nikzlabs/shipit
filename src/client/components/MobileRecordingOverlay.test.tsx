import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MobileRecordingOverlay } from "./MobileRecordingOverlay.js";
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
    cancelRecording: vi.fn(),
    onTranscript: vi.fn(() => () => {}),
    dismissError: vi.fn(),
    ...overrides,
  };
}

describe("MobileRecordingOverlay", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<MobileRecordingOverlay voice={makeVoice()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing in the error state (error falls back to the inline button)", () => {
    const { container } = render(
      <MobileRecordingOverlay voice={makeVoice({ state: "error", errorMessage: "nope" })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a big stop button and live timer while recording", () => {
    render(<MobileRecordingOverlay voice={makeVoice({ state: "recording", elapsedMs: 65_000 })} />);
    expect(screen.getByTestId("mobile-recording-overlay")).toHaveAttribute("data-state", "recording");
    expect(screen.getByText("01:05")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });

  it("stops when the big button is tapped", () => {
    const voice = makeVoice({ state: "recording" });
    render(<MobileRecordingOverlay voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(voice.stopRecording).toHaveBeenCalledTimes(1);
    expect(voice.cancelRecording).not.toHaveBeenCalled();
  });

  it("discards via Cancel without transcribing", () => {
    const voice = makeVoice({ state: "recording" });
    render(<MobileRecordingOverlay voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(voice.cancelRecording).toHaveBeenCalledTimes(1);
    expect(voice.stopRecording).not.toHaveBeenCalled();
  });

  it("cancels on Escape while recording", () => {
    const voice = makeVoice({ state: "recording" });
    render(<MobileRecordingOverlay voice={voice} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(voice.cancelRecording).toHaveBeenCalledTimes(1);
  });

  it("shows a transcribing spinner with no stop/cancel controls", () => {
    render(<MobileRecordingOverlay voice={makeVoice({ state: "transcribing" })} />);
    expect(screen.getByTestId("mobile-recording-overlay")).toHaveAttribute("data-state", "transcribing");
    expect(screen.getByText("Transcribing…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel recording" })).not.toBeInTheDocument();
  });
});
