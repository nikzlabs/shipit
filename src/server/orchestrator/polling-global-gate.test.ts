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

// The gate's viewer/autonomous-action decision is driven entirely through the
// PrStatusPoller public API (notifyViewerAttached/Detached, notifyAutoPush,
// trackSession), so these tests exercise PrStatusPoller and assert on the
// resulting poll cadence. docs/201 Phase P9.

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

  // ---- Viewer-gated polling (Strategy 1) ----

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

    // No viewers ever attached — gate is closed from the start; the
    // synchronous first-poll path in trackSession sees the closed gate and
    // skips.
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();

    // Drive time forward — still no polls.
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

    // Mimic the orchestrator: a viewer attaches → notifyViewerAttached, then
    // the WS path immediately force-refreshes the session it activated.
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

    // Viewer leaves. Within the 60s grace window the supervisor keeps
    // running so a quick reconnect doesn't re-burn.
    registry.setViewers("s1", 0);
    poller.notifyViewerDetached();

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    // Settled PR → cadence dropped to slow, so no fresh poll in this 15s tick.
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    // After the grace window elapses, the next supervisor tick sees the
    // gate closed and stops the supervisor — no further polls.
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

    // Network blip: detach, then reattach within the grace window.
    registry.setViewers("s1", 0);
    poller.notifyViewerDetached();
    await vi.advanceTimersByTimeAsync(20_000);
    registry.setViewers("s1", 1);
    poller.notifyViewerAttached();

    // Supervisor never stopped, so we keep ticking; settled PR stays slow.
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("headless turn (running runner, no viewer) keeps the gate open and polls continue", async () => {
    // PR has pending CI so the cadence is fast — without the headless-gate
    // signal, this would still be skipped (no viewer, no autonomous action).
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
    // No viewer attached — only the runner's running flag keeps the gate open.

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.trackSession("s1", "https://github.com/owner/repo");
    // trackSession's initial-poll path fires because the headless-running
    // gate is open. No need for an explicit forceRefreshSession here.
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    // Headless turn keeps fast cadence even with no viewer.
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});
