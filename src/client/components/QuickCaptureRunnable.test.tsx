/**
 * docs/257 req 3 — Quick Capture is inert on an install that cannot run a turn.
 *
 * A separate file from `QuickCaptureOverlay.test.tsx` on purpose: that suite
 * fakes `MessageInput` to inspect props, and the whole point here is that
 * passing the overlay's existing `disabled` prop is NOT enough. `disabled`
 * guards submission only, so a test that asserted it would certify the very bug
 * this prevents — a user typing, attaching and (via the voice hotkey) recording
 * into Quick Capture with just Send dead. So the real composer renders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { VoiceInputApi } from "../voice/use-voice-input.js";
import { useUiStore } from "../stores/ui-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import type { RepoInfo } from "../../server/shared/types.js";

const startRecording = vi.hoisted(() => vi.fn());

vi.mock("../voice/use-voice-input.js", () => ({
  useVoiceInput: (): VoiceInputApi => ({
    state: "idle",
    elapsedMs: 0,
    errorMessage: null,
    cleanupWarning: null,
    canRetryTranscription: false,
    startRecording,
    stopRecording: () => {},
    cancelRecording: () => {},
    retryTranscription: () => {},
    onTranscript: () => () => {},
    dismissError: () => {},
    dismissCleanupWarning: () => {},
  }),
}));

const { QuickCaptureOverlay } = await import("./QuickCaptureOverlay.js");

const REASON = "Add a service to start chatting";
const LIVE_PLACEHOLDER = "Describe what to build... (type @ to attach files)";
const REPO_URL = "https://github.com/acme/app.git";

function readyRepo(): RepoInfo {
  return {
    url: REPO_URL,
    status: "ready",
    addedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  startRecording.mockReset();
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  // Voice on and the hotkey-arm set: the state where a submission-only guard
  // would still start a recording the user cannot send.
  useSettingsStore.setState({ voiceInputEnabled: true, canRunTurns: false });
  useUiStore.setState({
    quickCaptureOpen: true,
    bootstrapLoaded: true,
    quickCaptureAutoMic: true,
    agentList: [],
    modelInfo: null,
  });
  useRepoStore.setState({ repos: [readyRepo()], activeRepoUrl: REPO_URL });
  useSessionStore.setState({ sessionId: undefined, sessions: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUiStore.setState({ quickCaptureOpen: false, bootstrapLoaded: false, quickCaptureAutoMic: false });
  useSettingsStore.setState({ canRunTurns: false, voiceInputEnabled: false });
  useRepoStore.setState({ repos: [], activeRepoUrl: undefined });
});

describe("QuickCaptureOverlay on a non-runnable install (docs/257 req 3)", () => {
  it("is not typeable and explains why", () => {
    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    expect(screen.getByPlaceholderText(REASON)).toBeDisabled();
  });

  it("cannot attach files", () => {
    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    expect(screen.getByLabelText("Add files")).toBeDisabled();
  });

  it("does not start recording even though the voice hotkey armed the mic", () => {
    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    expect(startRecording).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mic-button")).toBeNull();
  });

  it("is fully live once the install can run a turn", () => {
    // Non-vacuous complement — and the assertion that this change is scoped to
    // the not-runnable case and nothing else.
    useSettingsStore.setState({ canRunTurns: true });
    render(<QuickCaptureOverlay onAddRepo={vi.fn()} />);
    expect(screen.getByPlaceholderText(LIVE_PLACEHOLDER)).not.toBeDisabled();
    expect(screen.getByLabelText("Add files")).not.toBeDisabled();
    expect(startRecording).toHaveBeenCalled();
  });
});
