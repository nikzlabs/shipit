import { describe, expect, it, vi } from "vitest";
import { assertSessionCanDispatch, createRunnerRegistry } from "./runner-registry-factory.js";

describe("assertSessionCanDispatch", () => {
  it.each(["ops", "sandbox"] as const)(
    "allows %s sessions without consulting repository trust",
    (kind) => {
      const isTrusted = vi.fn(() => false);

      expect(() =>
        assertSessionCanDispatch(
          `${kind}-session`,
          { kind, remoteUrl: "https://github.com/owner/repo.git" },
          isTrusted,
        ),
      ).not.toThrow();
      expect(isTrusted).not.toHaveBeenCalled();
    },
  );

  it("still rejects an ordinary untrusted repository session", () => {
    expect(() =>
      assertSessionCanDispatch(
        "repo-session",
        { kind: undefined, remoteUrl: "https://github.com/owner/repo.git" },
        () => false,
      ),
    ).toThrow(expect.objectContaining({ code: "repository_untrusted" }));
  });
});

/**
 * planning#246 — the sidebar's "busy outside a turn" marker reaches other sessions
 * over the global SSE, and this factory holds the ONE subscriber that puts it
 * there. The runner announces its own changes (`background_work`) precisely so
 * no clear can be silent; that only pays off if the announcement is actually
 * wired, so this pins the wiring rather than the runner's own bookkeeping.
 */
describe("createRunnerRegistry — background-work marker wiring", () => {
  function makeRegistry() {
    const sseBroadcast = vi.fn();
    const registry = createRunnerRegistry({
      effectiveRunnerFactory: undefined,
      sessionManager: { get: () => undefined, getPrStatus: () => undefined } as never,
      repoStore: { isTrusted: () => true } as never,
      createGitManager: (() => ({})) as never,
      githubAuthManager: { authenticated: false } as never,
      agentFactory: undefined,
      chatHistoryManager: {} as never,
      autoPushScheduler: {
        schedule: () => {}, cancel: () => {}, cancelAll: () => {}, pending: () => false,
      },
      sseBroadcast,
      enforceIdleContainerLimit: () => {},
      getDepCacheDir: () => "",
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      composeWarnings: new Map(),
      composeNotConfigured: new Set(),
      containerManager: null,
      serviceEnvDir: "/tmp/service-env",
      // Skips the ServiceManager wiring entirely — irrelevant here and the
      // heaviest part of `onRunnerCreated`.
      runtimeMode: "local",
      broadcastLog: () => {},
      usageManager: {} as never,
    });
    const runner = registry.getOrCreate("s1", "/tmp/s1", "claude");
    const attention = () =>
      sseBroadcast.mock.calls
        .filter(([event]) => event === "session_attention")
        .map(([, payload]) => payload);
    return { runner, attention };
  }

  it("broadcasts the union when a background task appears and when it drains", () => {
    const { runner, attention } = makeRegistry();
    runner.isStreamingActive = true;

    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);
    expect(attention().at(-1)).toEqual({ sessionId: "s1", backgroundTasks: ["npm test"] });

    runner.setBackgroundTasks([]);
    expect(attention().at(-1)).toEqual({ sessionId: "s1", backgroundTasks: [] });

    runner.dispose({ force: true });
  });

  // The clears that had no announcement of their own before planning#246: a
  // spawn-identity change, a credential rotation, the stuck-running reconciler,
  // and dispose. Each left a green dot on a session with nothing running.
  it("broadcasts the drain on a bare clearBackgroundTasks", () => {
    const { runner, attention } = makeRegistry();
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);

    runner.clearBackgroundTasks();

    expect(attention().at(-1)).toEqual({ sessionId: "s1", backgroundTasks: [] });
    runner.dispose({ force: true });
  });

  it("broadcasts the drain when the runner is disposed", () => {
    const { runner, attention } = makeRegistry();
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "npm test" }]);

    runner.dispose({ force: true });

    expect(attention().at(-1)).toEqual({ sessionId: "s1", backgroundTasks: [] });
  });
});
