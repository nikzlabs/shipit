/**
 * docs/144 — dictation provenance on an AskUserQuestion "Other" answer.
 *
 * An "Other" answer becomes the next turn's prompt, so a spoken one carries
 * exactly the transcription artifacts a spoken chat message does and gets the
 * same `<dictated_input>` hint. The interesting rule is the negative one: a
 * question the user dictated into and then ABANDONED for a preset option
 * contributes no transcript to the prompt, so it must not flag the turn.
 *
 * `useVoiceInput` is faked at the module boundary — no mic, no fetch.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { VoiceInputApi } from "../voice/use-voice-input.js";
import type { AskQuestionItem } from "./AskUserQuestion.js";

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

const { AskUserQuestion } = await import("./AskUserQuestion.js");

function dictate(text: string) {
  act(() => {
    for (const cb of subscribers) cb(text);
  });
}

const question: AskQuestionItem[] = [
  {
    question: "Which caching strategy should we use?",
    header: "Cache type",
    options: [
      { label: "Redis", description: "External cache" },
      { label: "In-memory", description: "Per-process only" },
    ],
    multiSelect: false,
  },
];

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

describe("AskUserQuestion dictation provenance (docs/144)", () => {
  it("flags a dictated 'Other' answer", () => {
    const onAnswer = vi.fn(() => true);
    render(
      <AskUserQuestion toolUseId="t1" questions={question} onAnswer={onAnswer} disabled={false} />,
    );
    fireEvent.click(screen.getByTestId("option-other"));
    dictate("use red is");
    fireEvent.keyDown(screen.getByTestId("other-input"), { key: "Enter", shiftKey: false });
    expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "use red is" }, "use red is", true);
  });

  it("does not flag a typed 'Other' answer", () => {
    const onAnswer = vi.fn(() => true);
    render(
      <AskUserQuestion toolUseId="t1" questions={question} onAnswer={onAnswer} disabled={false} />,
    );
    fireEvent.click(screen.getByTestId("option-other"));
    fireEvent.change(screen.getByTestId("other-input"), { target: { value: "Redis Cluster" } });
    fireEvent.keyDown(screen.getByTestId("other-input"), { key: "Enter", shiftKey: false });
    expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis Cluster" }, "Redis Cluster");
  });

  it("does not flag a preset option picked after abandoning a dictated 'Other'", () => {
    // Nothing spoken reaches the prompt, so the hint would be describing text
    // that isn't there.
    const onAnswer = vi.fn(() => true);
    render(
      <AskUserQuestion toolUseId="t1" questions={question} onAnswer={onAnswer} disabled={false} />,
    );
    fireEvent.click(screen.getByTestId("option-other"));
    dictate("use red is");
    fireEvent.click(screen.getByText("Redis"));
    expect(onAnswer).toHaveBeenCalledWith("t1", { "0": "Redis" }, "Redis");
  });
});
