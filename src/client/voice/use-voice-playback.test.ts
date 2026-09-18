import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVoicePlayback } from "./use-voice-playback.js";
import { usePlaybackStore } from "./playback-store.js";
import { useSettingsStore } from "../stores/settings-store.js";

// stubs `new Audio().play()` rejects and the store would never reach

let playSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
let pauseSpy: ReturnType<typeof vi.fn<() => void>>;

function audioBlobResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(["audio-bytes"], { type: "audio/mpeg" })),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: () => Promise.resolve(new Blob([])),
    json: () => Promise.resolve({ error: "boom" }),
  } as unknown as Response;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe("useVoicePlayback", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {

    usePlaybackStore.setState({
      playingTurnId: null,
      state: "idle",
      positionMs: 0,
      durationMs: 0,
      errorMessage: null,
    });
    useSettingsStore.setState({ ttsVoice: "alloy", ttsSpeed: 1 });

    playSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    pauseSpy = vi.fn<() => void>();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(playSpy);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(pauseSpy);

    let counter = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:mock-${counter++}`),
      revokeObjectURL: vi.fn(),
    });

    fetchMock = vi.fn().mockResolvedValue(audioBlobResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {

    act(() => { usePlaybackStore.getState().stop(); });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("transitions loading → playing on a successful speak round-trip", async () => {
    const { result } = renderHook(() => useVoicePlayback());

    let pending: Promise<void>;
    act(() => { pending = result.current.play("t-play", "hello world"); });

    expect(result.current.state).toBe("loading");
    expect(result.current.playingTurnId).toBe("t-play");

    await act(async () => { await pending; });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith("/api/voice/speak", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(typeof request.body).toBe("string");
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ text: "hello world", voice: "alloy", speed: 1, provider: "openai" });
    expect(body.apiKey).toBeUndefined();
    expect(body.key).toBeUndefined();
    expect(body.authorization).toBeUndefined();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("playing");
    expect(result.current.playingTurnId).toBe("t-play");
  });

  it("leaves state idle when the server returns 204 (nothing to speak)", async () => {
    fetchMock.mockResolvedValue(emptyResponse(204));
    const { result } = renderHook(() => useVoicePlayback());

    await act(async () => { await result.current.play("t-204", "  "); });
    await flushMicrotasks();

    expect(result.current.state).toBe("idle");
    expect(result.current.playingTurnId).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("sets state 'error' when speak responds with a non-ok status", async () => {
    fetchMock.mockResolvedValue(emptyResponse(500));
    const { result } = renderHook(() => useVoicePlayback());

    await act(async () => { await result.current.play("t-error", "hello"); });
    await flushMicrotasks();

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toMatch(/couldn't play/i);
    expect(result.current.playingTurnId).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("supersedes an in-flight play of turn A when turn B is requested", async () => {

    let releaseA: (r: Response) => void = () => {};
    const aPending = new Promise<Response>((resolve) => { releaseA = resolve; });
    fetchMock
      .mockImplementationOnce(() => aPending)
      .mockImplementation(() => Promise.resolve(audioBlobResponse()));

    const { result } = renderHook(() => useVoicePlayback());

    let playA: Promise<void>;
    act(() => { playA = result.current.play("A", "alpha"); });
    expect(result.current.playingTurnId).toBe("A");

    await act(async () => { await result.current.play("B", "beta"); });
    await flushMicrotasks();
    expect(result.current.playingTurnId).toBe("B");
    expect(result.current.state).toBe("playing");

    // Now let A's fetch resolve — it must NOT clobber B's playback.
    await act(async () => {
      releaseA(audioBlobResponse());
      await playA;
    });
    await flushMicrotasks();

    expect(result.current.playingTurnId).toBe("B");
    expect(result.current.state).toBe("playing");

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds the blob cache and revokes evicted object URLs", async () => {
    const { result } = renderHook(() => useVoicePlayback());

    // creates an object URL, so the oldest must be revoked as we overflow.
    const N = 40;
    for (let i = 0; i < N; i++) {
      await act(async () => { await result.current.play(`evict-${i}`, `text ${i}`); });
      await flushMicrotasks();
      act(() => { usePlaybackStore.getState().stop(); });
    }

    expect(fetchMock).toHaveBeenCalledTimes(N);
    // Cache cap is 32, so at least N-32 evictions must have revoked their URL.
    const revoke = vi.mocked(URL.revokeObjectURL);
    expect(revoke.mock.calls.length).toBeGreaterThanOrEqual(N - 32);
  });

  it("caches the synthesized blob so replaying the same turn does not re-fetch", async () => {
    const { result } = renderHook(() => useVoicePlayback());

    await act(async () => { await result.current.play("t-cache", "hello"); });
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { usePlaybackStore.getState().stop(); });

    await act(async () => { await result.current.play("t-cache", "hello"); });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("playing");
  });
});
