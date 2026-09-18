import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, PR_STATUS_POLL_INTERVAL_MS, PR_STATUS_SLOW_INTERVAL_MS } from "./pr-status-poller.js";
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

describe("PrPollingSupervisor — per-repo cadence scaling (Strategy 2)", () => {
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

  it("settled PRs poll at slow cadence (120s), not fast (15s)", async () => {
    const successNode = makeGraphQLPrNode();
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [successNode] } } },
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

    await vi.advanceTimersByTimeAsync(60_000);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("pending CI forces fast cadence — every 15s", async () => {
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
    registry.setViewers("s1", 1);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.notifyViewerAttached();
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("post-push transitions to fast cadence for 5 minutes, then back to slow", async () => {
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

    await vi.advanceTimersByTimeAsync(60_000);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    poller.notifyAutoPush("s1");

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const callsAfterWindow = (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterWindow);
  });

  it("multi-repo: a pending-CI repo polls fast while a settled repo polls slow", async () => {
    const pendingNode = makeGraphQLPrNode({
      headRefName: "branch-a",
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
    const settledNode = makeGraphQLPrNode({ headRefName: "branch-b" });
    const graphql = vi.fn(async (_query: string, vars: { owner: string; name: string }) => {
      const node = vars.name === "repoA" ? pendingNode : settledNode;
      return { data: { repository: { pullRequests: { nodes: [node] } } } };
    });
    githubAuth = {
      authenticated: true,
      graphqlQuery: graphql,
      findPullRequestAnyState: vi.fn(),
      getRateLimitState: vi.fn().mockReturnValue({ limited: false, resetAt: null, remaining: null }),
    } as unknown as GitHubAuthManager;
    sessionManager = makeSessionManager([
      { id: "sA", branch: "branch-a", remoteUrl: "https://github.com/owner/repoA" },
      { id: "sB", branch: "branch-b", remoteUrl: "https://github.com/owner/repoB" },
    ]);
    const registry = makeFakeRegistry();
    registry.setViewers("sA", 1);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, runnerRegistry: registry });
    poller.notifyViewerAttached();
    poller.trackSession("sA", "https://github.com/owner/repoA");
    poller.trackSession("sB", "https://github.com/owner/repoB");

    await vi.advanceTimersByTimeAsync(0);
    const a0 = graphql.mock.calls.filter((c) => (c[1] as { name: string }).name === "repoA").length;
    const b0 = graphql.mock.calls.filter((c) => (c[1] as { name: string }).name === "repoB").length;
    expect(a0).toBe(1);
    expect(b0).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const aAfter = graphql.mock.calls.filter((c) => (c[1] as { name: string }).name === "repoA").length;
    const bAfter = graphql.mock.calls.filter((c) => (c[1] as { name: string }).name === "repoB").length;
    expect(aAfter).toBeGreaterThan(a0);
    expect(bAfter).toBe(b0);
  });
});
