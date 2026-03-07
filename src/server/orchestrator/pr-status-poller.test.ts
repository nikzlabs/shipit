import fs from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, parsePrNode, extractHeadSha, extractFailedCheckRuns } from "./pr-status-poller.js";
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

function makeSessionManager(sessions: { id: string; branch?: string; remoteUrl?: string }[]): SessionManager {
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

function makeGitHubAuth(graphqlResult: unknown = null, restProbeResult: unknown = null): GitHubAuthManager {
  return {
    authenticated: true,
    graphqlQuery: vi.fn().mockResolvedValue(graphqlResult),
    findPullRequestAnyState: vi.fn().mockResolvedValue(restProbeResult),
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

    const lastCall = sseBroadcast.mock.calls[1] as [string, { updates: { sessionId: string; prState: string }[] }];
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

// ---- Phase 2: failedChecks and auto-fix ----

describe("parsePrNode — failedChecks details", () => {
  it("populates failedChecks array from failing CheckRun nodes", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "abc123",
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { databaseId: 1, name: "test", status: "COMPLETED", conclusion: "FAILURE", title: "3 tests failed", detailsUrl: "https://example.com" },
                  { databaseId: 2, name: "lint", status: "COMPLETED", conclusion: "SUCCESS", title: "OK" },
                  { databaseId: 3, name: "build", status: "COMPLETED", conclusion: "CANCELLED", title: null },
                ],
              },
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks.failedChecks).toEqual([
      { name: "test", summary: "3 tests failed" },
      { name: "build", summary: "CANCELLED" },
    ]);
  });

  it("does not include failedChecks when all pass", () => {
    const node = makeGraphQLPrNode();
    const result = parsePrNode(node as never, "session-1");
    expect(result.checks.failedChecks).toBeUndefined();
  });

  it("includes StatusContext failures in failedChecks", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "abc123",
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { context: "ci/circleci", state: "FAILURE" },
                ],
              },
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.checks.failedChecks).toEqual([
      { name: "ci/circleci", summary: "failure" },
    ]);
  });
});

describe("extractHeadSha", () => {
  it("returns oid from the commit node", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{ commit: { oid: "abc123def", statusCheckRollup: null } }],
      },
    });
    expect(extractHeadSha(node as never)).toBe("abc123def");
  });

  it("returns undefined when no commits", () => {
    const node = makeGraphQLPrNode({ commits: { nodes: [] } });
    expect(extractHeadSha(node as never)).toBeUndefined();
  });
});

describe("extractFailedCheckRuns", () => {
  it("extracts failed check runs with databaseId", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "abc",
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { databaseId: 101, name: "test", status: "COMPLETED", conclusion: "FAILURE", title: "3 tests failed" },
                  { databaseId: 102, name: "lint", status: "COMPLETED", conclusion: "SUCCESS", title: "OK" },
                  { databaseId: 103, name: "build", status: "COMPLETED", conclusion: "TIMED_OUT", title: null },
                ],
              },
            },
          },
        }],
      },
    });

    const result = extractFailedCheckRuns(node as never);
    expect(result).toEqual([
      { databaseId: 101, name: "test", conclusion: "FAILURE", title: "3 tests failed" },
      { databaseId: 103, name: "build", conclusion: "TIMED_OUT", title: "TIMED_OUT" },
    ]);
  });

  it("returns empty array when no failures", () => {
    const node = makeGraphQLPrNode();
    expect(extractFailedCheckRuns(node as never)).toEqual([]);
  });
});

describe("PrStatusPoller — auto-fix state", () => {
  let pollerAF: PrStatusPoller;
  let sseBroadcastAF: ReturnType<typeof vi.fn<(event: string, data: unknown) => void>>;

  beforeEach(() => {
    sseBroadcastAF = vi.fn<(event: string, data: unknown) => void>();
    pollerAF = new PrStatusPoller({
      githubAuth: { authenticated: false, graphqlQuery: vi.fn() } as unknown as GitHubAuthManager,
      sessionManager: makeSessionManager([]),
      sseBroadcast: sseBroadcastAF,
    });
  });

  afterEach(() => {
    pollerAF.destroy();
  });

  it("setAutoFixEnabled creates state", () => {
    const state = pollerAF.setAutoFixEnabled("s1", true);
    expect(state).toMatchObject({ enabled: true, attemptCount: 0, status: "idle" });
  });

  it("markAutoFixRunning increments count and sets running", () => {
    pollerAF.setAutoFixEnabled("s1", true);
    pollerAF.markAutoFixRunning("s1");
    const state = pollerAF.getAutoFixState("s1");
    expect(state).toMatchObject({ enabled: true, attemptCount: 1, status: "running" });
  });

  it("getAllStatuses includes autoFix state", async () => {
    // Create poller with real auth and data
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    vi.useFakeTimers();
    const poller2 = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast: sseBroadcastAF });
    poller2.trackSession("s1", "https://github.com/owner/repo");
    poller2.setAutoFixEnabled("s1", true);

    // Need to poll to populate lastKnown
    await vi.advanceTimersByTimeAsync(0);

    const statuses = poller2.getAllStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].autoFix).toMatchObject({ enabled: true, attemptCount: 0 });
    poller2.destroy();
    vi.useRealTimers();
  });
});

// ---- Phase 3: Catch-up probe for already-merged PRs ----

describe("PrStatusPoller — catch-up probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects merged PR via catch-up probe when no prior state exists", async () => {
    const noPrs = { data: { repository: { pullRequests: { nodes: [] } } } };
    const mergedProbe = {
      url: "https://github.com/owner/repo/pull/99",
      number: 99,
      base: "main",
      title: "Merged feature",
      state: "closed" as const,
      merged_at: "2024-01-01T00:00:00Z",
      additions: 50,
      deletions: 10,
    };

    const githubAuth = makeGitHubAuth(noPrs, mergedProbe);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/merged-branch", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll: no open PR → triggers catch-up probe
    await vi.advanceTimersByTimeAsync(0);
    // Allow catch-up probe promise to resolve
    await vi.advanceTimersByTimeAsync(0);

    // The probe should have broadcast a merged status
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId: "s1", prState: "merged", prNumber: 99 })],
    }));

    // Should trigger post-merge archive
    expect(onMergeDetected).toHaveBeenCalledWith("s1");

    poller.destroy();
  });

  it("detects closed (not merged) PR via catch-up probe", async () => {
    const noPrs = { data: { repository: { pullRequests: { nodes: [] } } } };
    const closedProbe = {
      url: "https://github.com/owner/repo/pull/88",
      number: 88,
      base: "main",
      title: "Closed feature",
      state: "closed" as const,
      merged_at: null,
      additions: 30,
      deletions: 5,
    };

    const githubAuth = makeGitHubAuth(noPrs, closedProbe);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/closed-branch", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Should broadcast closed status
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId: "s1", prState: "closed", prNumber: 88 })],
    }));

    // Should NOT trigger archive for closed (not merged) PRs
    expect(onMergeDetected).not.toHaveBeenCalled();

    poller.destroy();
  });

  it("fires catch-up probe only once per session", async () => {
    const noPrs = { data: { repository: { pullRequests: { nodes: [] } } } };
    const githubAuth = makeGitHubAuth(noPrs, null); // probe returns null (no PR found)
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/no-pr-branch", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll — triggers catch-up
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    // Second poll — no catch-up (already consumed)
    await vi.advanceTimersByTimeAsync(3000);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    poller.destroy();
  });

  it("skips catch-up probe when session has matching open PR", async () => {
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    const githubAuth = makeGitHubAuth(withPr);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // Probe should NOT have been called since the GraphQL query found an open PR
    expect(githubAuth.findPullRequestAnyState).not.toHaveBeenCalled();

    poller.destroy();
  });
});

// ---- Workflow detection: none → pending override ----

describe("PrStatusPoller — workflow-aware CI state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("overrides checks.state to 'pending' when repo has workflow files and no checks reported", async () => {
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    // Mock fs to simulate workflow files existing
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readdirSyncSpy = vi.spyOn(fs, "readdirSync").mockReturnValue(["ci.yml"] as never);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending", total: 0 }),
      })],
    }));

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });

  it("keeps checks.state as 'none' when repo has no workflow files", async () => {
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    // Mock fs to simulate no workflow directory
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "none", total: 0 }),
      })],
    }));

    existsSyncSpy.mockRestore();
    poller.destroy();
  });

  it("does not override when checks already reported", async () => {
    // PR with actual checks (state: "success")
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readdirSyncSpy = vi.spyOn(fs, "readdirSync").mockReturnValue(["ci.yml"] as never);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // Should remain "success", not overridden to "pending"
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        checks: expect.objectContaining({ state: "success" }),
      })],
    }));

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });
});
