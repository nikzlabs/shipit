import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, parsePrNode } from "./pr-status-poller.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";

// ---- Helpers ----

function makeGraphQLPrNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add feature",
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    headRefName: "shipit/abc-feature",
    baseRefName: "main",
    additions: 100,
    deletions: 20,
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              nodes: [
                { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            },
          },
        },
      }],
    },
    ...overrides,
  };
}

function makeSessionManager(sessions: Array<{ id: string; branch?: string; remoteUrl?: string }>): SessionManager {
  return {
    list: () => sessions.map((s) => ({
      id: s.id,
      title: "Test",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      branch: s.branch,
      remoteUrl: s.remoteUrl,
    })),
    get: (id: string) => sessions.find((s) => s.id === id) as never,
  } as unknown as SessionManager;
}

function makeGitHubAuth(graphqlResult: unknown = null): GitHubAuthManager {
  return {
    authenticated: true,
    graphqlQuery: vi.fn().mockResolvedValue(graphqlResult),
  } as unknown as GitHubAuthManager;
}

// ---- Tests ----

describe("parsePrNode", () => {
  it("parses a successful PR node into PrStatusSummary", () => {
    const node = makeGraphQLPrNode();
    const result = parsePrNode(node as never, "session-1");

    expect(result).toMatchObject({
      sessionId: "session-1",
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      prTitle: "Add feature",
      prState: "open",
      baseBranch: "main",
      headBranch: "shipit/abc-feature",
      insertions: 100,
      deletions: 20,
      checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 },
      mergeable: true,
      autoMergeEnabled: false,
    });
  });

  it("detects failed checks", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
                  { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
                ],
              },
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks).toMatchObject({ state: "failure", total: 2, passed: 1, failed: 1, pending: 0 });
  });

  it("detects pending checks", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: {
                nodes: [
                  { name: "test", status: "IN_PROGRESS", conclusion: null },
                  { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                ],
              },
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks).toMatchObject({ state: "pending", total: 2, passed: 1, failed: 0, pending: 1 });
  });

  it("handles no statusCheckRollup (no CI)", () => {
    const node = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks).toMatchObject({ state: "none", total: 0, passed: 0, failed: 0, pending: 0 });
  });

  it("detects auto-merge enabled", () => {
    const node = makeGraphQLPrNode({
      autoMergeRequest: { mergeMethod: "SQUASH" },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.autoMergeEnabled).toBe(true);
  });

  it("detects not-mergeable PR", () => {
    const node = makeGraphQLPrNode({ mergeable: "CONFLICTING" });
    const result = parsePrNode(node as never, "session-1");
    expect(result.mergeable).toBe(false);
  });

  it("handles StatusContext nodes (legacy status API)", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { context: "ci/circleci", state: "SUCCESS" },
                  { context: "deploy/vercel", state: "FAILURE" },
                ],
              },
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks).toMatchObject({ state: "failure", total: 2, passed: 1, failed: 1, pending: 0 });
  });
});

describe("PrStatusPoller", () => {
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

  it("starts polling when a session is tracked", async () => {
    const graphqlResult = {
      data: {
        repository: {
          pullRequests: {
            nodes: [makeGraphQLPrNode()],
          },
        },
      },
    };

    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // Initial poll fires immediately
    await vi.advanceTimersByTimeAsync(0);

    expect(githubAuth.graphqlQuery).toHaveBeenCalled();
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", prNumber: 42 }),
      ]),
    }));
  });

  it("only broadcasts when status changes", async () => {
    const graphqlResult = {
      data: {
        repository: {
          pullRequests: {
            nodes: [makeGraphQLPrNode()],
          },
        },
      },
    };

    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll
    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    // Second poll — same data, no broadcast
    await vi.advanceTimersByTimeAsync(3000);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("detects merged PR when it disappears from OPEN results", async () => {
    // First poll: PR exists
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(withPr);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    // Second poll: PR disappeared (merged)
    const withoutPr = {
      data: { repository: { pullRequests: { nodes: [] } } },
    };
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue(withoutPr);

    await vi.advanceTimersByTimeAsync(3000);
    expect(sseBroadcast).toHaveBeenCalledTimes(2);

    const lastCall = sseBroadcast.mock.calls[1] as [string, { updates: Array<{ sessionId: string; prState: string }> }];
    expect(lastCall[1].updates[0]).toMatchObject({ sessionId: "s1", prState: "merged" });
  });

  it("getAllStatuses returns current state", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    const statuses = poller.getAllStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ sessionId: "s1", prNumber: 42 });
  });

  it("stops polling when all sessions are untracked", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    poller.untrackSession("s1");

    // Advance time — no more polls should happen
    await vi.advanceTimersByTimeAsync(10000);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);
  });

  it("does not poll when not authenticated", async () => {
    githubAuth = { authenticated: false, graphqlQuery: vi.fn() } as unknown as GitHubAuthManager;
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
    expect(sseBroadcast).not.toHaveBeenCalled();
  });
});
