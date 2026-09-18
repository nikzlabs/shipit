import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, PR_STATUS_POLL_INTERVAL_MS } from "./pr-status-poller.js";
import {
  makeFakeRegistry,
  makeGraphQLPrNode,
  makeSessionManager,
  makeGitHubAuth,
} from "./pr-poller-test-helpers.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";

// eslint-disable-next-line no-restricted-syntax -- vi.mock's importOriginal generic needs an inline import() type
vi.mock("./workflow-loader.js", async (importOriginal: () => Promise<typeof import("./workflow-loader.js")>) => {
  const actual = await importOriginal();
  return { ...actual, loadAndParseWorkflows: vi.fn() };
});

describe("PollingGlobalGate — viewer-gated polling (Strategy 1)", () => {
  let poller: PrStatusPoller;
  let sseBroadcast: ReturnType<typeof vi.fn<(event: string, data: unknown) => void>>;
  let githubAuth: GitHubAuthManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sseBroadcast = vi.fn<(event: string, data: unknown) => void>();
  });

  afterEach(() => {
    poller?.destroy();
    vi.useRealTimers();
  });

  it("does not poll when no viewers are attached and no autonomous action is in flight", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
  });

  it("viewer attach kicks an immediate poll", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();

    registry.setViewers("s1", 1);
    poller.notifyViewerAttached();
    await poller.forceRefreshSession("s1");

    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);
  });

  it("viewer detach + grace pauses the supervisor", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();
    registry.setViewers("s1", 1);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.notifyViewerAttached();
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    registry.setViewers("s1", 0);
    poller.notifyViewerDetached();

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const callsAfterPause = (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterPause);
  });

  it("reconnect within the grace window does not re-burn the budget on resume", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();
    registry.setViewers("s1", 1);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.notifyViewerAttached();
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    registry.setViewers("s1", 0);
    poller.notifyViewerDetached();
    await vi.advanceTimersByTimeAsync(20_000);
    registry.setViewers("s1", 1);
    poller.notifyViewerAttached();

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("armed auto-fix (enabled, no viewer, no running runner) keeps the gate open and polls continue", async () => {
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [pendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      runnerRegistry: registry,
      isAutoFixEnabled: () => true,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not keep polling for a viewerless session when auto-fix is disabled", async () => {
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [pendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      runnerRegistry: registry,
      isAutoFixEnabled: () => false,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
  });

  it("armed auto-resolve (enabled, no viewer) keeps the gate open and polls continue", async () => {
    const conflictingPendingNode = makeGraphQLPrNode({
      mergeable: "CONFLICTING",
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [conflictingPendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      runnerRegistry: registry,
      isAutoResolveEnabled: () => true,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not keep polling for a viewerless session when auto-resolve is disabled", async () => {
    const conflictingPendingNode = makeGraphQLPrNode({
      mergeable: "CONFLICTING",
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [conflictingPendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      runnerRegistry: registry,
      isAutoResolveEnabled: () => false,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
  });

  it("a pending notify-on-merge watch keeps the gate open with no viewer", async () => {
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [pendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager(
      [{ id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" }],
      { pendingMergeWatches: ["s1"] },
    );
    const registry = makeFakeRegistry();

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("headless turn (running runner, no viewer) keeps the gate open and polls continue", async () => {
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [pendingNode] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();
    registry.setRunning("s1", true);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
