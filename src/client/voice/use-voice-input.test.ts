import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// `waitFor` from RTL polls on real timers, which deadlocks under
// `vi.useFakeTimers()`. The hook also installs a recurring `setInterval`
// while recording, so `runAllTimersAsync()` would loop forever. Instead we
// flush only the pending microtask queue (Promise continuations) inside
// `act()`, which is enough to resolve the capture/transcribe chains.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    // A handful of turns drains the start → recording → transcribe chain.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

// --- Controllable fake ActiveCapture ----------------------------------------
//
// startCapture() resolves with one of these. stop() resolves with a fixed
// blob; abort() is tracked. Tests inspect `lastCapture` to assert lifecycle.

interface FakeCapture {
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

let lastCapture: FakeCapture | null = null;
let startCaptureImpl: () => Promise<FakeCapture>;

vi.mock("./capture.js", () => ({
  startCapture: () => startCaptureImpl(),
  MicPermissionError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MicPermissionError";
    }
  },
}));

// Import after the mock is registered so the hook picks up the fake module.
import { useVoiceInput, eventMatchesPtt } from "./use-voice-input.js";
// Same class instance the hook's `instanceof MicPermissionError` checks against.
import { MicPermissionError } from "./capture.js";

function makeFakeCapture(blob = new Blob(["audio"], { type: "audio/webm" })): FakeCapture {
  const cap: FakeCapture = {
    stop: vi.fn().mockResolvedValue({ blob, mimeType: "audio/webm" }),
    abort: vi.fn(),
  };
  lastCapture = cap;
  return cap;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function keyEvent(opts: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...opts,
  } as KeyboardEvent;
}

describe("eventMatchesPtt", () => {
  it("matches a held ctrl+shift+space event", () => {
    const e = keyEvent({ key: " ", ctrlKey: true, shiftKey: true });
    expect(eventMatchesPtt(e, "ctrl+shift+space")).toBe(true);
  });

  it("rejects when a required modifier is missing", () => {
    const e = keyEvent({ key: " ", ctrlKey: true }); // no shift
    expect(eventMatchesPtt(e, "ctrl+shift+space")).toBe(false);
  });

  it("rejects when an extra modifier is held", () => {
    const e = keyEvent({ key: " ", ctrlKey: true, shiftKey: true, altKey: true });
    expect(eventMatchesPtt(e, "ctrl+shift+space")).toBe(false);
  });

  it("treats 'mod' as either ctrl or meta", () => {
    expect(eventMatchesPtt(keyEvent({ key: "k", ctrlKey: true }), "mod+k")).toBe(true);
    expect(eventMatchesPtt(keyEvent({ key: "k", metaKey: true }), "mod+k")).toBe(true);
    expect(eventMatchesPtt(keyEvent({ key: "k" }), "mod+k")).toBe(false);
  });

  it("normalizes space / spacebar key naming", () => {
    expect(eventMatchesPtt(keyEvent({ key: " " }), "space")).toBe(true);
    expect(eventMatchesPtt(keyEvent({ key: "Spacebar" }), "space")).toBe(true);
    expect(eventMatchesPtt(keyEvent({ key: "a" }), "space")).toBe(false);
  });

  it("returns false for a hotkey with no non-modifier key", () => {
    expect(eventMatchesPtt(keyEvent({ key: "Control", ctrlKey: true }), "ctrl")).toBe(false);
  });
});

describe("useVoiceInput", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    lastCapture = null;
    startCaptureImpl = () => Promise.resolve(makeFakeCapture());
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ text: "hello", rawText: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is inert when enabled is false — startRecording does nothing", async () => {
    const startSpy = vi.fn(() => Promise.resolve(makeFakeCapture()));
    startCaptureImpl = startSpy;

    const { result } = renderHook(() => useVoiceInput({ enabled: false }));
    act(() => result.current.startRecording());
    await act(async () => { await Promise.resolve(); });

    expect(startSpy).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it("runs the full happy path: record → stop after MIN_RECORDING_MS → transcribe", async () => {
    const { result } = renderHook(() => useVoiceInput({ enabled: true, cleanup: true }));

    const received: string[] = [];
    act(() => { result.current.onTranscript((t) => received.push(t)); });

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    expect(result.current.state).toBe("recording");

    // Hold past the minimum recording threshold (250ms).
    await act(async () => { vi.advanceTimersByTime(300); });

    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("idle");
    expect(lastCapture?.stop).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/voice/transcribe", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toBeUndefined();
    const form = request.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.has("apiKey")).toBe(false);
    expect(form.has("key")).toBe(false);
    expect(form.has("authorization")).toBe(false);
    expect(received).toEqual(["hello"]);
  });

  it("aborts and emits nothing on a too-short press (< MIN_RECORDING_MS)", async () => {
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));
    const received: string[] = [];
    act(() => { result.current.onTranscript((t) => received.push(t)); });

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    expect(result.current.state).toBe("recording");

    // Release almost immediately — under the 250ms floor.
    await act(async () => { vi.advanceTimersByTime(50); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(lastCapture?.abort).toHaveBeenCalledTimes(1);
    expect(lastCapture?.stop).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    expect(result.current.state).toBe("idle");
  });

  it("sets state 'error' and emits nothing when transcribe responds !ok", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, { ok: false, status: 500 }));
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));
    const received: string[] = [];
    act(() => { result.current.onTranscript((t) => received.push(t)); });

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    expect(result.current.state).toBe("recording");
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBe("boom");
    expect(received).toEqual([]);
  });

  it("falls back to the generic transcription error when the response has no detail", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error("bad json")) });
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toBe("Couldn't transcribe — try again");
  });

  it("retains the audio after a transcribe failure and resends it verbatim on retry", async () => {
    // First transcribe call fails; the audio must be retained for a resend.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, { ok: false, status: 500 }));
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));
    const received: string[] = [];
    act(() => { result.current.onTranscript((t) => received.push(t)); });

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.canRetryTranscription).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry resends without re-recording — capture.stop() is NOT called again.
    act(() => { result.current.retryTranscription(); });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastCapture?.stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("idle");
    expect(result.current.canRetryTranscription).toBe(false);
    expect(received).toEqual(["hello"]);
  });

  it("does not offer a transcription retry when capture never started (mic permission)", async () => {
    startCaptureImpl = () => Promise.reject(new MicPermissionError("denied"));
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.canRetryTranscription).toBe(false);
    // No retained audio → retryTranscription is a no-op (no network call).
    act(() => { result.current.retryTranscription(); });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a cleanupWarning when cleanupErrorCode is present and cleanup was requested", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ text: "hi", rawText: "hi", cleanupErrorCode: "rate_limited" }),
    );
    const { result } = renderHook(() => useVoiceInput({ enabled: true, cleanup: true }));
    const received: string[] = [];
    act(() => { result.current.onTranscript((t) => received.push(t)); });

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    expect(result.current.state).toBe("recording");
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("idle");
    expect(result.current.cleanupWarning).toMatch(/cleanup unavailable/i);
    // The raw transcript is still inserted.
    expect(received).toEqual(["hi"]);
  });

  it("clears the cleanupWarning via dismissCleanupWarning (transcript sent to agent)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ text: "hi", rawText: "hi", cleanupErrorCode: "rate_limited" }),
    );
    const { result } = renderHook(() => useVoiceInput({ enabled: true, cleanup: true }));

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();
    expect(result.current.cleanupWarning).toMatch(/cleanup unavailable/i);

    act(() => { result.current.dismissCleanupWarning(); });
    expect(result.current.cleanupWarning).toBeNull();
  });

  it("clears the cleanupWarning when the session switches", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ text: "hi", rawText: "hi", cleanupErrorCode: "rate_limited" }),
    );
    const { result, rerender } = renderHook(
      (props: { sessionId: string }) =>
        useVoiceInput({ enabled: true, cleanup: true, sessionId: props.sessionId }),
      { initialProps: { sessionId: "s1" } },
    );

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();
    await act(async () => { vi.advanceTimersByTime(300); });
    act(() => { result.current.stopRecording(); });
    await flushMicrotasks();
    expect(result.current.cleanupWarning).toMatch(/cleanup unavailable/i);

    act(() => { rerender({ sessionId: "s2" }); });
    expect(result.current.cleanupWarning).toBeNull();
  });

  it("discards the recording when the session switches during getUserMedia", async () => {
    // startCapture stays pending until we release it, simulating a slow
    // getUserMedia that resolves AFTER the user switched sessions.
    const cap = makeFakeCapture();
    let releaseCapture: () => void = () => {};
    startCaptureImpl = () =>
      new Promise<FakeCapture>((resolve) => { releaseCapture = () => resolve(cap); });

    const { result, rerender } = renderHook(
      (props: { sessionId: string }) => useVoiceInput({ enabled: true, sessionId: props.sessionId }),
      { initialProps: { sessionId: "s1" } },
    );

    act(() => { result.current.startRecording(); });
    await flushMicrotasks(); // async block is now awaiting startCapture()

    // Session switches before getUserMedia resolves.
    act(() => { rerender({ sessionId: "s2" }); });

    // The capture finally resolves into the now-stale "s1" recording attempt.
    await act(async () => { releaseCapture(); });
    await flushMicrotasks();

    // The stale capture is aborted; nothing is recorded or transcribed.
    expect(cap.abort).toHaveBeenCalledTimes(1);
    expect(result.current.state).not.toBe("recording");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a MicPermissionError message when capture fails to start", async () => {
    startCaptureImpl = () =>
      Promise.reject(new MicPermissionError("Microphone access denied — enable it"));
    const { result } = renderHook(() => useVoiceInput({ enabled: true }));

    act(() => { result.current.startRecording(); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toMatch(/denied/i);
  });
});
