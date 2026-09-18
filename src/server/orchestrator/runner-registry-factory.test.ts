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

describe("createRunnerRegistry — docs/288 merge-hold seeding", () => {
  function makeRegistry(isAgentMergeInFlight?: (sessionId: string) => boolean) {
    return createRunnerRegistry({
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
      sseBroadcast: () => {},
      enforceIdleContainerLimit: () => {},
      getDepCacheDir: () => "",
      serviceManagers: new Map(),
      composeStopPromises: new Map(),
      composeWarnings: new Map(),
      composeNotConfigured: new Set(),
      containerManager: null,
      serviceEnvDir: "/tmp/service-env",
      runtimeMode: "local",
      broadcastLog: () => {},
      usageManager: {} as never,
      ...(isAgentMergeInFlight ? { isAgentMergeInFlight } : {}),
    });
  }

  it("creates a runner already held when its session's merge is in flight", () => {
    const registry = makeRegistry((sessionId) => sessionId === "merging-session");
    const runner = registry.getOrCreate("merging-session", "/tmp/s1", "claude");
    expect(runner.mergeHold).toBe(true);
    runner.dispose({ force: true });
  });

  it("also leases the seeded runner against reclamation", () => {
    const registry = makeRegistry(() => true);
    const runner = registry.getOrCreate("merging-session", "/tmp/s1", "claude");
    expect(runner.postTurnWorkInFlight).toBe(true);
    expect(runner.agentBusy).toBe(true);
    runner.dispose({ force: true });
  });

  it("creates an ordinary runner unheld", () => {
    const registry = makeRegistry((sessionId) => sessionId === "merging-session");
    const runner = registry.getOrCreate("other-session", "/tmp/s2", "claude");
    expect(runner.mergeHold).toBe(false);
    expect(runner.postTurnWorkInFlight).toBe(false);
    runner.dispose({ force: true });
  });

  it("creates an unheld runner when no merge executor is wired at all", () => {
    const runner = makeRegistry().getOrCreate("s1", "/tmp/s1", "claude");
    expect(runner.mergeHold).toBe(false);
    runner.dispose({ force: true });
  });
});

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
