import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSessionHistory } from "./session-data.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePermissionStore } from "../stores/permission-store.js";

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

  // docs/193 — guards the client/server key alignment: the persisted card uses
  // `requestId` (the broker id, same key the store/render/resolve use). If it
  // ever drifts back to `cardId`, this rehydrate seeds nothing and the card
  // vanishes on reload.
  it("rehydrates the permission store from a persisted card on reload", async () => {
    usePermissionStore.getState().reset();
    useSessionStore.getState().setSessionId("perm-sess");
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            messages: [
              {
                role: "assistant",
                text: "",
                permissionPrompt: {
                  requestId: "perm-abc",
                  phase: "approved",
                  toolName: "Write",
                  path: ".npmrc",
                  summary: "Write .npmrc",
                  agentId: "claude",
                  createdAt: "2026-06-11T00:00:00.000Z",
                  remembered: true,
                },
              },
            ],
            commits: [],
            fileTree: [],
            agentRunning: false,
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await loadSessionHistory("perm-sess");

    const card = usePermissionStore.getState().cards["perm-abc"];
    expect(card).toBeDefined();
    expect(card?.phase).toBe("approved");
    expect(card?.remembered).toBe(true);
    expect(card?.path).toBe(".npmrc");
  });
});

/**
 * docs/235 — switching into a session that is between turns with a background
 * job outstanding showed "Waiting for a background task to finish" for a beat
 * and then went blank, while the sidebar kept showing the session as working.
 * The status line came from a live/replayed `background_tasks` message and the
 * blank came from this hydration, which read only `agentRunning` and cleared
 * the bar unconditionally.
 */
describe("loadSessionHistory — background-task hydration", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  const historyWith = (backgroundTasks?: string[], agentRunning = false) => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes("/history")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            messages: [],
            commits: [],
            fileTree: [],
            agentRunning,
            ...(backgroundTasks ? { backgroundTasks } : {}),
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
  };

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the status line up for a between-turns session with outstanding work", async () => {
    useSessionStore.getState().setSessionId("bg-sess");
    historyWith(["npm test"]);

    await loadSessionHistory("bg-sess");

    const state = useSessionStore.getState();
    expect(state.isLoading).toBe(true);
    expect(state.activity?.label).toBe("Waiting for: npm test");
    // No tool call is running, so the tool spinner would be a lie.
    expect(state.activity?.tool).toBeUndefined();
    expect(state.backgroundTaskSessions.get("bg-sess")).toEqual(["npm test"]);
  });

  it("upgrades the unnamed SSE-snapshot marker to the named label", async () => {
    useSessionStore.getState().setSessionId("bg-sess");
    // The `session_attention` snapshot carries ids only — no descriptions.
    useSessionStore.getState().setBackgroundTaskSessions(() => new Map([["bg-sess", []]]));
    historyWith(["build the docs site"]);

    await loadSessionHistory("bg-sess");

    expect(useSessionStore.getState().activity?.label).toBe("Waiting for: build the docs site");
  });

  it("clears the marker and the status line when nothing is outstanding", async () => {
    useSessionStore.getState().setSessionId("bg-sess");
    useSessionStore.getState().setBackgroundTaskSessions(() => new Map([["bg-sess", ["stale"]]]));
    historyWith([]);

    await loadSessionHistory("bg-sess");

    const state = useSessionStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.activity).toBeUndefined();
    expect(state.backgroundTaskSessions.has("bg-sess")).toBe(false);
  });

  it("leaves other sessions' markers alone", async () => {
    useSessionStore.getState().setSessionId("bg-sess");
    useSessionStore.getState().setBackgroundTaskSessions(() => new Map([["other-sess", ["theirs"]]]));
    historyWith([]);

    await loadSessionHistory("bg-sess");

    expect(useSessionStore.getState().backgroundTaskSessions.get("other-sess")).toEqual(["theirs"]);
  });

  it("a running turn still wins — the turn owns the status line", async () => {
    useSessionStore.getState().setSessionId("bg-sess");
    historyWith(["npm test"], true);

    await loadSessionHistory("bg-sess");

    const state = useSessionStore.getState();
    expect(state.isLoading).toBe(true);
    // Not overwritten with a "Waiting for…" label: live tool activity owns it.
    expect(state.activity).toBeUndefined();
    expect(state.backgroundTaskSessions.get("bg-sess")).toEqual(["npm test"]);
  });
});

/**
 * The reported bug: switch away from the browser window, come back, and part
 * of the transcript is gone — but a full page reload brings it back, so the
 * rows were only missing from client memory (docs/237 tells the two causes
 * apart by exactly that question).
 *
 * `useWebSocket` force-reconnects on foreground, so a history load issued for
 * the outgoing socket can still be in flight when the incoming socket opens
 * and issues its own. Nothing cancelled the first one, and its `setMessages`
 * lands whenever it lands — so a response read BEFORE the running turn's
 * latest persist boundary could overwrite a fresher transcript and take the
 * turn's tail with it. Live events only append after that, so the hole never
 * healed.
 */
describe("loadSessionHistory — a superseded load must not clobber the transcript", () => {
  let resolvers: ((value: unknown) => void)[];

  const historyPayload = (texts: string[]) => ({
    ok: true,
    json: () => Promise.resolve({
      messages: texts.map((text) => ({ role: "assistant", text, inProgress: true })),
      commits: [],
      fileTree: [],
      agentRunning: true,
    }),
  });

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    useSessionStore.getState().setSessionId("s1");
    resolvers = [];
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes("/history")) {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores the older response when two loads for the same session overlap", async () => {
    // Load A: issued for the socket the foreground handler is about to replace.
    const first = loadSessionHistory("s1");
    // Load B: issued when the fresh socket opened, a moment later.
    const second = loadSessionHistory("s1");
    await vi.waitFor(() => expect(resolvers.length).toBe(2));

    // B answers first — it read the DB after the turn's latest persist.
    resolvers[1](historyPayload(["GROUP-ONE", "GROUP-TWO"]));
    await second;
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["GROUP-ONE", "GROUP-TWO"]);

    // A answers late, carrying the older snapshot. It must be discarded: this
    // is the write that used to erase GROUP-TWO for the rest of the session.
    resolvers[0](historyPayload(["GROUP-ONE"]));
    await first;
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["GROUP-ONE", "GROUP-TWO"]);
  });

  it("does not let a superseded load flip historyLoaded mid-reconnect", async () => {
    const first = loadSessionHistory("s1");
    await vi.waitFor(() => expect(resolvers.length).toBe(1));

    // The socket dropped again: useConnectionSync clears the flag and issues a
    // new load. `turn_snapshot` is queued behind this flag (useMessageHandler),
    // so a stale load raising it would let the snapshot apply against an
    // arbitrary transcript instead of on top of the history baseline.
    useSessionStore.getState().setHistoryLoaded(false);
    const second = loadSessionHistory("s1");
    await vi.waitFor(() => expect(resolvers.length).toBe(2));

    resolvers[0](historyPayload(["GROUP-ONE"]));
    await first;
    expect(useSessionStore.getState().historyLoaded).toBe(false);

    resolvers[1](historyPayload(["GROUP-ONE", "GROUP-TWO"]));
    await second;
    expect(useSessionStore.getState().historyLoaded).toBe(true);
  });
});

/**
 * planning#375 — the seq guard makes a superseded load harmless, not free. A
 * DevTools trace of a foreground reconnect caught two `/history` requests
 * 480 ms apart at 2.67 MB each, the older one downloaded and `JSON.parse`d
 * purely to be discarded, on the main thread that was already the bottleneck.
 * Issuing a load now cancels the one it supersedes.
 */
describe("loadSessionHistory — a superseded load is cancelled, not just discarded", () => {
  let calls: { url: string; signal: AbortSignal; resolve: (v: unknown) => void }[];

  const historyPayload = (texts: string[]) => ({
    ok: true,
    json: () => Promise.resolve({
      messages: texts.map((text) => ({ role: "assistant", text })),
      commits: [],
      fileTree: [],
      agentRunning: false,
    }),
  });

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    useSessionStore.getState().setSessionId("s1");
    calls = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!url.includes("/history")) return Promise.resolve({ ok: false, status: 404 });
      const signal = init!.signal!;
      return new Promise((resolve, reject) => {
        calls.push({ url, signal, resolve });
        // A real fetch rejects with an AbortError the moment the signal fires.
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("aborts the in-flight request when a second load is issued", async () => {
    const first = loadSessionHistory("s1");
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].signal.aborted).toBe(false);

    const second = loadSessionHistory("s1");
    await vi.waitFor(() => expect(calls.length).toBe(2));

    // The older request is cancelled — its body is never downloaded or parsed.
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);

    // And the cancelled load resolves rather than throwing: `useConnectionSync`
    // treats a throw as a real failure and suppresses its retry nudge.
    await expect(first).resolves.toBeUndefined();

    calls[1].resolve(historyPayload(["GROUP-ONE", "GROUP-TWO"]));
    await second;
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["GROUP-ONE", "GROUP-TWO"]);
  });

  it("does not abort a load that already settled", async () => {
    const first = loadSessionHistory("s1");
    await vi.waitFor(() => expect(calls.length).toBe(1));
    calls[0].resolve(historyPayload(["ONE"]));
    await first;

    // The second load has nothing to supersede, so it must not fire an abort
    // at a controller whose response is already applied.
    const second = loadSessionHistory("s1");
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].signal.aborted).toBe(false);
    calls[1].resolve(historyPayload(["ONE", "TWO"]));
    await second;
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["ONE", "TWO"]);
  });

  it("propagates a genuine network failure", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await expect(loadSessionHistory("s1")).rejects.toThrow("offline");
  });
});
