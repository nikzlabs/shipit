import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { VoicePlaybackApi } from "../voice/use-voice-playback.js";
import type { PlaybackState } from "../voice/playback-store.js";

// Mock the playback hook the component consumes so we control state + assert actions.
const playbackApi: VoicePlaybackApi = {
  state: "idle",
  playingTurnId: null,
  positionMs: 0,
  durationMs: 0,
  errorMessage: null,
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
};

vi.mock("../voice/use-voice-playback.js", () => ({
  useVoicePlayback: () => playbackApi,
}));

import { PlayTurnButton } from "./PlayTurnButton.js";

function setPlayback(overrides: Partial<VoicePlaybackApi>) {
  Object.assign(playbackApi, overrides);
}

beforeEach(() => {
  setPlayback({
    state: "idle" as PlaybackState,
    playingTurnId: null,
    positionMs: 0,
    durationMs: 0,
    errorMessage: null,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PlayTurnButton", () => {
  it("renders a Play control for an idle turn", () => {
    render(<PlayTurnButton turnId="t1" text="hello world" />);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("calls play(turnId, text) when the Play button is clicked", () => {
    render(<PlayTurnButton turnId="t1" text="hello world" />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(playbackApi.play).toHaveBeenCalledTimes(1);
    expect(playbackApi.play).toHaveBeenCalledWith("t1", "hello world");
  });

  it("does not show playing UI for a turn that is not the active one", () => {
    setPlayback({ state: "playing", playingTurnId: "other", durationMs: 100, positionMs: 50 });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    // This turn reads as idle → Play, no Stop control.
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop playback" })).not.toBeInTheDocument();
  });

  it("switches to Pause affordance and pauses when this turn is playing", () => {
    setPlayback({ state: "playing", playingTurnId: "t1", durationMs: 100, positionMs: 25 });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    const pauseBtn = screen.getByRole("button", { name: "Pause" });
    expect(pauseBtn).toBeInTheDocument();
    fireEvent.click(pauseBtn);
    expect(playbackApi.pause).toHaveBeenCalledTimes(1);
  });

  it("resumes when this turn is paused", () => {
    setPlayback({ state: "paused", playingTurnId: "t1", durationMs: 100, positionMs: 25 });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    const resumeBtn = screen.getByRole("button", { name: "Resume" });
    fireEvent.click(resumeBtn);
    expect(playbackApi.resume).toHaveBeenCalledTimes(1);
  });

  it("shows a Stop control while this turn owns the player, and stops on click", () => {
    setPlayback({ state: "playing", playingTurnId: "t1", durationMs: 100, positionMs: 25 });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    const stopBtn = screen.getByRole("button", { name: "Stop playback" });
    fireEvent.click(stopBtn);
    expect(playbackApi.stop).toHaveBeenCalledTimes(1);
  });

  it("shows a busy spinner and ignores clicks while loading this turn", () => {
    setPlayback({ state: "loading", playingTurnId: "t1" });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    // Loading keeps the main label as "Play"; clicking is a no-op.
    const btn = screen.getByRole("button", { name: "Play" });
    fireEvent.click(btn);
    expect(playbackApi.play).not.toHaveBeenCalled();
  });

  it("renders a retry error affordance and re-plays on click when this turn errored", () => {
    setPlayback({ state: "error", playingTurnId: "t1", errorMessage: "Synthesis failed" });
    render(<PlayTurnButton turnId="t1" text="hello" />);
    const retryBtn = screen.getByRole("button", { name: "Retry playback" });
    fireEvent.click(retryBtn);
    expect(playbackApi.play).toHaveBeenCalledWith("t1", "hello");
  });

  it("exposes a labelled playback speed selector", () => {
    render(<PlayTurnButton turnId="t1" text="hello" />);
    expect(screen.getByRole("combobox", { name: "Playback speed" })).toBeInTheDocument();
  });
});
