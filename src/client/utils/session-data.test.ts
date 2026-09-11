import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSessionHistory, __resetHistoryCache } from "./session-data.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePermissionStore } from "../stores/permission-store.js";
import { useBugReportStore } from "../stores/bug-report-store.js";
import { useEgressPromptStore } from "../stores/egress-prompt-store.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import type { IssueWriteCard } from "../../server/shared/types.js";

describe("loadSessionHistory — modelInfo seeding", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();

    fetchSpy = vi.fn();

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

  it("clears a previous session's context reading when this session has no turns", async () => {
    useUiStore.getState().setContextTokens(64_000);
    useSessionStore.getState().setSessionId("fresh-session");
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
              turnUsage: [],
              sessionUsage: null,
              cumulativeInputTokens: 0,
              cumulativeOutputTokens: 0,
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });

    await loadSessionHistory("fresh-session");

    expect(useUiStore.getState().contextTokens).toBe(0);
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

    expect(state.activity?.tool).toBeUndefined();
    expect(state.backgroundTaskSessions.get("bg-sess")).toEqual(["npm test"]);
  });

  it("upgrades the unnamed SSE-snapshot marker to the named label", async () => {
    useSessionStore.getState().setSessionId("bg-sess");

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

    const first = loadSessionHistory("s1");

    const second = loadSessionHistory("s1");
    await vi.waitFor(() => expect(resolvers.length).toBe(2));

    resolvers[1](historyPayload(["GROUP-ONE", "GROUP-TWO"]));
    await second;
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["GROUP-ONE", "GROUP-TWO"]);

    // A answers late, carrying the older snapshot. It must be discarded: this

    resolvers[0](historyPayload(["GROUP-ONE"]));
    await first;
    expect(useSessionStore.getState().messages.map((m) => m.text))
      .toEqual(["GROUP-ONE", "GROUP-TWO"]);
  });

  it("does not let a superseded load flip historyLoaded mid-reconnect", async () => {
    const first = loadSessionHistory("s1");
    await vi.waitFor(() => expect(resolvers.length).toBe(1));

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

describe("loadSessionHistory — revalidates instead of re-downloading", () => {
  let requests: { headers: Record<string, string>; cache?: string }[];
  let etag: string;
  let body: { messages: { role: string; text: string }[]; commits: never[]; agentRunning: boolean };

  const respond = () => {
    const ifNoneMatch = requests[requests.length - 1].headers["If-None-Match"];
    if (ifNoneMatch === etag) {
      return Promise.resolve({ ok: true, status: 304, headers: new Headers({ etag }), json: () => { throw new Error("must not parse a 304"); } });
    }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers({ etag }), json: () => Promise.resolve(body) });
  };

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    __resetHistoryCache();
    requests = [];
    etag = '"v1"';
    body = { messages: [{ role: "assistant", text: "ONE" }], commits: [], agentRunning: false };
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!url.includes("/history")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tree: [] }) });
      requests.push({ headers: (init?.headers ?? {}) as Record<string, string>, cache: init?.cache });
      return respond();
    }) as unknown as typeof fetch;
  });

  afterEach(() => { vi.restoreAllMocks(); __resetHistoryCache(); });

  it("sends no validator on the first load and caches what comes back", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    expect(requests[0].headers["If-None-Match"]).toBeUndefined();
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["ONE"]);
  });

  it("revalidates on the next load and applies the cached transcript on a 304", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    useSessionStore.getState().setMessages([]);

    await loadSessionHistory("s1");
    expect(requests[1].headers["If-None-Match"]).toBe('"v1"');

    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["ONE"]);
  });

  it("takes the new body when the server's tag moved", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");

    etag = '"v2"';
    body = { messages: [{ role: "assistant", text: "ONE" }, { role: "assistant", text: "TWO" }], commits: [], agentRunning: false };
    await loadSessionHistory("s1");
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["ONE", "TWO"]);

    await loadSessionHistory("s1");
    expect(requests[2].headers["If-None-Match"]).toBe('"v2"');
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["ONE", "TWO"]);
  });

  it("bypasses the browser's own HTTP cache so the 304 is visible to us", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");

    expect(requests[0].cache).toBe("no-store");
  });

  it("keeps the cache bounded", async () => {
    for (let i = 0; i < 9; i++) {
      useSessionStore.getState().setSessionId(`s${i}`);
      await loadSessionHistory(`s${i}`);
    }

    useSessionStore.getState().setSessionId("s0");
    await loadSessionHistory("s0");
    expect(requests[requests.length - 1].headers["If-None-Match"]).toBeUndefined();

    useSessionStore.getState().setSessionId("s8");
    await loadSessionHistory("s8");
    expect(requests[requests.length - 1].headers["If-None-Match"]).toBe('"v1"');
  });

  it("does not evict the session the user keeps coming back to", async () => {

    // being revisited is the one that never gets re-inserted, and it ages out

    useSessionStore.getState().setSessionId("favourite");
    await loadSessionHistory("favourite");

    for (let i = 0; i < 5; i++) {
      useSessionStore.getState().setSessionId(`other${i}`);
      await loadSessionHistory(`other${i}`);

      useSessionStore.getState().setSessionId("favourite");
      await loadSessionHistory("favourite");
    }

    expect(requests[requests.length - 1].headers["If-None-Match"]).toBe('"v1"');
  });
});

/**
 * planning#467 — what a `304` install may and may not cost.
 *
 * The install itself is unconditional: it is the switch-back baseline restore,
 * and it is what wipes client-only rows. What must NOT survive is its price.
 * `TranscriptRow` takes its message as the `anchor` prop — "the row's catch-all
 * change signal" — so a freshly-mapped `ChatMessage` per row is a memo miss per
 * row, and planning#375 measured that whole-transcript re-render at 92 ms over
 * ~2,000 rows. Re-mapping the SAME cached payload paid it again on every
 * foreground reconnect, which planning#324 made cheaper and therefore more
 * frequent.
 *
 * These assert on object identity rather than on render counts on purpose: the
 * identity is the contract `transcript-row-memo.test.tsx` and
 * `visual-elements.ts:reuseUnchanged` consume, and a test that counted renders
 * here would pass against a `messages` array rebuilt row-for-row.
 */

function issueWriteCard(cardId: string, undoState: IssueWriteCard["undoState"]): IssueWriteCard {
  return {
    cardId,
    tracker: "github",
    issueId: "42",
    identifier: "octocat/hello#42",
    title: "Bug",
    verb: "comment",
    summary: "commented on octocat/hello#42",
    attribution: "user",
    undo: { kind: "comment", commentId: "c-9" },
    undoState,
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}

describe("loadSessionHistory — a validated 304 re-installs the same rows, not copies of them", () => {
  let requests: { headers: Record<string, string> }[];
  let etag: string;
  let body: { messages: Record<string, unknown>[]; commits: never[]; agentRunning: boolean };

  const respond = () => {
    const ifNoneMatch = requests[requests.length - 1].headers["If-None-Match"];
    if (ifNoneMatch === etag) {
      return Promise.resolve({ ok: true, status: 304, headers: new Headers({ etag }), json: () => { throw new Error("must not parse a 304"); } });
    }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers({ etag }), json: () => Promise.resolve(body) });
  };

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    usePermissionStore.getState().reset();
    useBugReportStore.getState().reset();
    useEgressPromptStore.getState().reset();
    useIssueWriteStore.getState().reset();
    __resetHistoryCache();
    requests = [];
    etag = '"v1"';
    body = {
      messages: [{ role: "assistant", text: "ONE" }, { role: "assistant", text: "TWO" }],
      commits: [],
      agentRunning: false,
    };
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!url.includes("/history")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tree: [] }) });
      requests.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return respond();
    }) as unknown as typeof fetch;
  });

  afterEach(() => { vi.restoreAllMocks(); __resetHistoryCache(); });

  it("hands the store the identical array, so no subscriber re-renders", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    const first = useSessionStore.getState().messages;

    await loadSessionHistory("s1");

    expect(useSessionStore.getState().messages).toBe(first);
  });

  it("restores a cleared transcript from the same row objects", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    const rows = [...useSessionStore.getState().messages];

    // install genuinely has to run. It must still not rebuild the rows.
    useSessionStore.getState().setMessages([]);
    await loadSessionHistory("s1");

    const restored = useSessionStore.getState().messages;
    expect(restored.map((m) => m.text)).toEqual(["ONE", "TWO"]);
    expect(restored[0]).toBe(rows[0]);
    expect(restored[1]).toBe(rows[1]);
  });

  it("materializes fresh rows once the server's tag moves", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    const stale = useSessionStore.getState().messages[0];

    etag = '"v2"';
    body = { messages: [{ role: "assistant", text: "EDITED" }], commits: [], agentRunning: false };
    await loadSessionHistory("s1");

    expect(useSessionStore.getState().messages[0]).not.toBe(stale);
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["EDITED"]);
  });

  it("keeps each session's rows to itself", async () => {
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    const s1Rows = useSessionStore.getState().messages;

    body = { messages: [{ role: "assistant", text: "OTHER" }], commits: [], agentRunning: false };
    etag = '"s2"';
    useSessionStore.getState().setSessionId("s2");
    await loadSessionHistory("s2");
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["OTHER"]);
    expect(useSessionStore.getState().messages[0]).not.toBe(s1Rows[0]);
  });

  it("still seeds ALL FOUR card stores on a 304, over replay-created drafts", async () => {

    // ETag says nothing about — so a cached body must not excuse them. PR #2536

    etag = '"cards"';
    body = {
      messages: [{
        role: "assistant",
        text: "ONE",
        permissionPrompt: { requestId: "r1", phase: "approved", toolName: "bash" },
        bugReport: { cardId: "b1", phase: "filed", title: "t", body: "b", stage2Ran: true, producer: "session", issueNumber: 7 },
        egressPrompt: { cardId: "e1", phase: "approved", host: "example.com" },
        issueWrite: issueWriteCard("w1", "undone"),
      }],
      commits: [],
      agentRunning: false,
    };
    useSessionStore.getState().setSessionId("s1");
    await loadSessionHistory("s1");
    expect(usePermissionStore.getState().cards.r1?.phase).toBe("approved");
    expect(useBugReportStore.getState().cards.b1?.phase).toBe("filed");
    expect(useEgressPromptStore.getState().cards.e1?.phase).toBe("approved");
    expect(useIssueWriteStore.getState().cards.w1?.undoState).toBe("undone");

    // write. Reached here by clearing the stores first, because today's
    // `upsertCard` is deliberately non-clobbering and so cannot demote a card
    // that survived in memory. The seed must not depend on that: it is the

    usePermissionStore.getState().reset();
    useBugReportStore.getState().reset();
    useEgressPromptStore.getState().reset();
    useIssueWriteStore.getState().reset();
    usePermissionStore.getState().upsertCard({ requestId: "r1", toolName: "bash" });
    useBugReportStore.getState().upsertCard({ cardId: "b1", title: "t", body: "b", stage2Ran: true, producer: "session" });
    useEgressPromptStore.getState().upsertCard({ cardId: "e1", host: "example.com" });
    useIssueWriteStore.getState().upsertCard(issueWriteCard("w1", "available"));
    expect(usePermissionStore.getState().cards.r1?.phase).toBe("pending");
    expect(useBugReportStore.getState().cards.b1?.phase).toBe("draft");
    expect(useEgressPromptStore.getState().cards.e1?.phase).toBe("pending");
    expect(useIssueWriteStore.getState().cards.w1?.undoState).toBe("available");

    await loadSessionHistory("s1");
    expect(requests[1].headers["If-None-Match"]).toBe('"cards"');
    expect(usePermissionStore.getState().cards.r1?.phase).toBe("approved");
    expect(useBugReportStore.getState().cards.b1?.phase).toBe("filed");
    expect(useEgressPromptStore.getState().cards.e1?.phase).toBe("approved");
    expect(useIssueWriteStore.getState().cards.w1?.undoState).toBe("undone");
  });
});

/**
 * planning#375 — the file tree moved out of the history response. It must still
 * be session-scoped: a fire-and-forget fetch through the file store had no
 * active-session check, so a slow response for the session the user just LEFT
 * would land afterwards and overwrite the one they switched to.
 */
describe("loadSessionHistory — the file tree is session-scoped", () => {
  let treeResolvers: Record<string, (v: unknown) => void>;

  const ok = (json: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(json) });

  beforeEach(() => {
    useUiStore.getState().reset();
    useSessionStore.getState().reset();
    useGitStore.getState().reset();
    useFileStore.getState().reset();
    __resetHistoryCache();
    treeResolvers = {};
    globalThis.fetch = vi.fn((url: string) => {
      const id = /sessions\/([^/]+)\//.exec(url)?.[1] ?? "";
      if (url.endsWith("/files")) {
        return new Promise((resolve) => { treeResolvers[id] = resolve; });
      }
      return Promise.resolve(ok({
        messages: [{ role: "assistant", text: id }],
        commits: [],
        agentRunning: false,
      }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => { vi.restoreAllMocks(); __resetHistoryCache(); });

  it("drops a tree that arrives for a session the user has left", async () => {
    useSessionStore.getState().setSessionId("A");
    const loadA = loadSessionHistory("A");
    await vi.waitFor(() => expect(treeResolvers.A).toBeDefined());

    useSessionStore.getState().setSessionId("B");
    const loadB = loadSessionHistory("B");
    await vi.waitFor(() => expect(treeResolvers.B).toBeDefined());

    treeResolvers.B(ok({ tree: [{ name: "b.txt", path: "b.txt", type: "file" }] }));
    await loadB;
    expect(useFileStore.getState().tree.map((n) => n.name)).toEqual(["b.txt"]);

    // A's tree finally answers. It must not replace B's.
    treeResolvers.A(ok({ tree: [{ name: "a.txt", path: "a.txt", type: "file" }] }));
    await loadA;
    expect(useFileStore.getState().tree.map((n) => n.name)).toEqual(["b.txt"]);
  });

  it("applies the tree for the session that is still active", async () => {
    useSessionStore.getState().setSessionId("A");
    const loadA = loadSessionHistory("A");
    await vi.waitFor(() => expect(treeResolvers.A).toBeDefined());
    treeResolvers.A(ok({ tree: [{ name: "a.txt", path: "a.txt", type: "file" }] }));
    await loadA;
    expect(useFileStore.getState().tree.map((n) => n.name)).toEqual(["a.txt"]);
  });

  it("does not lose the transcript when the tree request fails", async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.endsWith("/files")) return Promise.reject(new Error("tree down"));
      return Promise.resolve(ok({ messages: [{ role: "assistant", text: "STILL HERE" }], commits: [], agentRunning: false }));
    }) as unknown as typeof fetch;

    useSessionStore.getState().setSessionId("A");
    await loadSessionHistory("A");
    expect(useSessionStore.getState().messages.map((m) => m.text)).toEqual(["STILL HERE"]);
  });
});
