import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSessionHistory } from "./session-data.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";

/**
 * Repro for the bug where the cost/context dial disappeared from below the
 * input whenever the session agent wasn't actively running. The dial reads
 * `modelInfo` from `useUiStore`, and the server only emits `model_info` over
 * WS on `agent_init`, so any path that loads a session purely from HTTP
 * history (page reload, session switch) used to leave `modelInfo` null —
 * which made `ContextDial` return null and hid the dial entirely. The fix
 * seeds `modelInfo` from the most recent turn that recorded a `model` field
 * in `turnUsage`.
 */
describe("loadSessionHistory — modelInfo seeding", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();

    fetchSpy = vi.fn();
    // First call is /history, second is /preview-status — we only care about
    // the former here, so return a benign 404 for everything else.
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              messages: [],
              commits: [],
              fileTree: [],
              agentRunning: false,
              turnUsage: [
                {
                  inputTokens: 100,
                  outputTokens: 50,
                  costUsd: 0.001,
                  timestamp: "2026-05-19T00:00:00Z",
                  model: "claude-sonnet-4-20250514",
                },
              ],
              sessionUsage: null,
              cumulativeInputTokens: 100,
              cumulativeOutputTokens: 50,
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds modelInfo from the most recent turn's model field", async () => {
    useSessionStore.getState().setSessionId("sess-1");
    expect(useUiStore.getState().modelInfo).toBeNull();
    await loadSessionHistory("sess-1");
    const info = useUiStore.getState().modelInfo;
    expect(info).not.toBeNull();
    expect(info?.model).toBe("claude-sonnet-4-20250514");
    // Sonnet substring → 200K window
    expect(info?.contextWindowTokens).toBe(200_000);
  });

  it("walks backward to find the most recent turn that recorded a model", async () => {
    useSessionStore.getState().setSessionId("sess-2");
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              messages: [],
              commits: [],
              fileTree: [],
              agentRunning: false,
              // Latest turn lacks a `model` (legacy data) — should fall back
              // to the prior turn that did record one.
              turnUsage: [
                {
                  inputTokens: 100,
                  outputTokens: 50,
                  costUsd: 0.001,
                  timestamp: "2026-05-18T00:00:00Z",
                  model: "claude-opus-4-8",
                },
                {
                  inputTokens: 200,
                  outputTokens: 80,
                  costUsd: 0.002,
                  timestamp: "2026-05-19T00:00:00Z",
                },
              ],
              cumulativeInputTokens: 300,
              cumulativeOutputTokens: 130,
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await loadSessionHistory("sess-2");
    const info = useUiStore.getState().modelInfo;
    expect(info?.model).toBe("claude-opus-4-8");
    // Opus 4.8 → 1M window
    expect(info?.contextWindowTokens).toBe(1_000_000);
  });

  it("leaves modelInfo null when no turn recorded a model", async () => {
    useSessionStore.getState().setSessionId("sess-3");
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              messages: [],
              commits: [],
              fileTree: [],
              agentRunning: false,
              turnUsage: [
                {
                  inputTokens: 100,
                  outputTokens: 50,
                  costUsd: 0.001,
                  timestamp: "2026-05-19T00:00:00Z",
                },
              ],
              cumulativeInputTokens: 100,
              cumulativeOutputTokens: 50,
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await loadSessionHistory("sess-3");
    expect(useUiStore.getState().modelInfo).toBeNull();
  });

  it("ignores history responses for sessions that are no longer active", async () => {
    useSessionStore.getState().setSessionId("old-session");
    let resolveHistory!: (value: {
      messages: { role: string; text: string }[];
      commits: never[];
      fileTree: never[];
      agentRunning: boolean;
    }) => void;
    const historyPromise = new Promise<{
      messages: { role: string; text: string }[];
      commits: never[];
      fileTree: never[];
      agentRunning: boolean;
    }>((resolve) => {
      resolveHistory = resolve;
    });
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () => historyPromise,
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    const load = loadSessionHistory("old-session");
    useSessionStore.getState().setSessionId("new-session");
    resolveHistory({
      messages: [{ role: "assistant", text: "stale" }],
      commits: [],
      fileTree: [],
      agentRunning: false,
    });
    await load;

    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().historyLoaded).toBe(false);
    expect(useGitStore.getState().commits).toEqual([]);
    expect(useFileStore.getState().tree).toEqual([]);
  });
});
