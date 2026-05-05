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
    setPrStatus: vi.fn(),
    getAllPrStatuses: vi.fn().mockReturnValue([]),
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
      mergeable: "mergeable",
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

  it("maps GraphQL MERGEABLE to \"mergeable\"", () => {
    const node = makeGraphQLPrNode({ mergeable: "MERGEABLE" });
    const result = parsePrNode(node as never, "session-1");
    expect(result.mergeable).toBe("mergeable");
  });

  it("maps GraphQL CONFLICTING to \"conflicting\"", () => {
    const node = makeGraphQLPrNode({ mergeable: "CONFLICTING" });
    const result = parsePrNode(node as never, "session-1");
    expect(result.mergeable).toBe("conflicting");
  });

  it("maps GraphQL UNKNOWN to \"unknown\"", () => {
    const node = makeGraphQLPrNode({ mergeable: "UNKNOWN" });
    const result = parsePrNode(node as never, "session-1");
    expect(result.mergeable).toBe("unknown");
  });

  it("maps unexpected GraphQL values to \"unknown\" (defensive)", () => {
    const node = makeGraphQLPrNode({ mergeable: "SOMETHING_NEW" });
    const result = parsePrNode(node as never, "session-1");
    expect(result.mergeable).toBe("unknown");
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

  it("parses deployments from commit", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
            deployments: {
              nodes: [
                {
                  environment: "Production",
                  latestStatus: { state: "SUCCESS", environmentUrl: "https://example.com" },
                  createdAt: "2026-03-24T00:00:00Z",
                  creator: { login: "vercel[bot]" },
                },
                {
                  environment: "Preview",
                  latestStatus: { state: "PENDING", environmentUrl: null },
                  createdAt: "2026-03-24T00:00:00Z",
                  creator: null,
                },
              ],
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.deployments).toHaveLength(2);
    expect(result.deployments![0]).toEqual({
      environment: "Production",
      state: "success",
      environmentUrl: "https://example.com",
      createdAt: "2026-03-24T00:00:00Z",
      creator: "vercel[bot]",
    });
    expect(result.deployments![1]).toEqual({
      environment: "Preview",
      state: "pending",
      environmentUrl: null,
      createdAt: "2026-03-24T00:00:00Z",
      creator: null,
    });
  });

  it("returns undefined deployments when commit has no deployments", () => {
    const node = makeGraphQLPrNode();
    const result = parsePrNode(node as never, "session-1");
    expect(result.deployments).toBeUndefined();
  });

  it("maps deployment states correctly", () => {
    const makeWithState = (state: string) => makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: null,
            deployments: {
              nodes: [{
                environment: "Test",
                latestStatus: { state, environmentUrl: null },
                createdAt: "2026-03-24T00:00:00Z",
                creator: null,
              }],
            },
          },
        }],
      },
    });

    expect(parsePrNode(makeWithState("SUCCESS") as never, "s1").deployments![0].state).toBe("success");
    expect(parsePrNode(makeWithState("ACTIVE") as never, "s1").deployments![0].state).toBe("success");
    expect(parsePrNode(makeWithState("FAILURE") as never, "s1").deployments![0].state).toBe("failure");
    expect(parsePrNode(makeWithState("ERROR") as never, "s1").deployments![0].state).toBe("error");
    expect(parsePrNode(makeWithState("INACTIVE") as never, "s1").deployments![0].state).toBe("inactive");
    expect(parsePrNode(makeWithState("IN_PROGRESS") as never, "s1").deployments![0].state).toBe("in_progress");
    expect(parsePrNode(makeWithState("QUEUED") as never, "s1").deployments![0].state).toBe("queued");
    expect(parsePrNode(makeWithState("PENDING") as never, "s1").deployments![0].state).toBe("pending");
  });

  it("handles null latestStatus on deployment", () => {
    const node = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: null,
            deployments: {
              nodes: [{
                environment: "Production",
                latestStatus: null,
                createdAt: "2026-03-24T00:00:00Z",
                creator: { login: "netlify[bot]" },
              }],
            },
          },
        }],
      },
    });

    const result = parsePrNode(node as never, "session-1");
    expect(result.deployments![0]).toEqual({
      environment: "Production",
      state: "pending",
      environmentUrl: null,
      createdAt: "2026-03-24T00:00:00Z",
      creator: "netlify[bot]",
    });
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

  describe("PR snapshot persistence", () => {
    it("writes PR status to SessionManager on each update", async () => {
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

      expect(sessionManager.setPrStatus).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ sessionId: "s1", prNumber: 42, prState: "open" }),
      );
    });

    it("loadPersisted seeds lastKnown so archived sessions appear in getAllStatuses", () => {
      const persisted = [
        {
          sessionId: "archived-1",
          prNumber: 7,
          prUrl: "https://github.com/o/r/pull/7",
          prTitle: "Old work",
          prState: "merged" as const,
          baseBranch: "main",
          headBranch: "shipit/old",
          insertions: 5,
          deletions: 1,
          checks: { state: "success" as const, total: 1, passed: 1, failed: 0, pending: 0 },
          mergeable: "unknown" as const,
          autoMergeEnabled: false,
        },
      ];
      githubAuth = makeGitHubAuth();
      sessionManager = {
        list: () => [],
        get: () => undefined,
        setPrStatus: vi.fn(),
        getAllPrStatuses: vi.fn().mockReturnValue(persisted),
      } as unknown as SessionManager;

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.loadPersisted();

      const all = poller.getAllStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "archived-1", prState: "merged" });
    });

    it("loadPersisted strips runtime-only autoFix/autoMerge fields", () => {
      const persistedWithRuntime = [{
        sessionId: "s1",
        prNumber: 1,
        prUrl: "u",
        prTitle: "t",
        prState: "open" as const,
        baseBranch: "main",
        headBranch: "h",
        insertions: 0,
        deletions: 0,
        checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: "unknown" as const,
        autoMergeEnabled: false,
        // These should NOT survive into runtime — they live in their own maps
        autoFix: { enabled: true, status: "running" as const, attemptCount: 1, maxAttempts: 3 },
        autoMerge: { enabled: true, mergeMethod: "squash" as const },
      }];
      githubAuth = makeGitHubAuth();
      sessionManager = {
        list: () => [],
        get: () => undefined,
        setPrStatus: vi.fn(),
        getAllPrStatuses: vi.fn().mockReturnValue(persistedWithRuntime),
      } as unknown as SessionManager;

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.loadPersisted();

      const all = poller.getAllStatuses();
      expect(all[0].autoFix).toBeUndefined();
      expect(all[0].autoMerge).toBeUndefined();
    });

    it("clearPersisted broadcasts a removal and clears from SessionManager", () => {
      githubAuth = makeGitHubAuth();
      sessionManager = makeSessionManager([]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });

      poller.clearPersisted("s-archived");

      expect(sessionManager.setPrStatus).toHaveBeenCalledWith("s-archived", null);
      expect(sseBroadcast).toHaveBeenCalledWith(
        "pr_status",
        expect.objectContaining({ updates: [], removals: ["s-archived"] }),
      );
    });
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

  it("skips polling when client is idle and no CI is pending", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // Initial poll fires (client just connected, considered active)
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    // Advance past the idle timeout (30s) — polls during this window still fire
    await vi.advanceTimersByTimeAsync(31_000);
    const callsBeforeIdle = (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBeforeIdle).toBeGreaterThan(1); // polls during the active window

    // Now advance another 30s — client is idle & CI is success → polls should be skipped
    await vi.advanceTimersByTimeAsync(30_000);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeIdle);
  });

  it("keeps polling when client is idle but CI is pending", async () => {
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "PENDING",
              contexts: {
                nodes: [
                  { name: "test", status: "IN_PROGRESS", conclusion: null },
                ],
              },
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

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // Initial poll
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenCalledTimes(1);

    // Advance past idle timeout — but CI is pending, so polling should continue
    await vi.advanceTimersByTimeAsync(31_000);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("resumes polling after recordClientActivity is called", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // Initial poll + advance past idle timeout
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(31_000);
    const callsBeforeIdle = (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length;

    // Confirm idle — no more polls
    await vi.advanceTimersByTimeAsync(9_000);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeIdle);

    // User comes back — send heartbeat
    poller.recordClientActivity();

    // Next poll tick should fire
    await vi.advanceTimersByTimeAsync(3_000);
    expect((githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBeforeIdle);
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

  it("retries workflow detection when first inspection finds no files (negative results not cached)", async () => {
    // Repo where workflow files appear after the first poll (e.g., shared
    // clone fetched the workflow files between polls). Our PR has no checks
    // reported yet, so the override path is the only thing standing between
    // the user and a falsely-mergeable button.
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

    // First poll: workflow dir doesn't exist yet.
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const readdirSyncSpy = vi.spyOn(fs, "readdirSync").mockReturnValue([] as never);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // First poll: state stays "none" because no workflows AND no observed checks.
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "none" }),
      })],
    }));

    // Workflow files appear before the next poll.
    sseBroadcast.mockClear();
    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["ci.yml"] as never);

    // Advance to the next poll tick.
    await vi.advanceTimersByTimeAsync(3_000);

    // Now the override should fire — state flips to "pending".
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });

  it("treats 'none' as 'pending' when another PR in the same repo has observed checks (external CI)", async () => {
    // Repo with no local .github/workflows files, but an existing PR that
    // already has checks (e.g., from an external CI provider like Vercel or
    // a third-party status check). A newly opened PR shouldn't show the
    // merge button just because its workflows haven't registered yet.
    const newPrNoChecks = makeGraphQLPrNode({
      number: 100,
      headRefName: "shipit/abc-feature",
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    });
    const otherPrWithChecks = makeGraphQLPrNode({
      number: 99,
      headRefName: "other-branch",
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                nodes: [{ name: "vercel", status: "COMPLETED", conclusion: "SUCCESS" }],
              },
            },
          },
        }],
      },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [newPrNoChecks, otherPrWithChecks] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    // No local workflow files at all.
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // Override should fire because the OTHER PR in the same repo has checks
    // — that's enough signal that the repo runs CI.
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

    existsSyncSpy.mockRestore();
    poller.destroy();
  });

  it("keeps 'none' for repos that genuinely run no CI (no workflows, no observed checks anywhere)", async () => {
    // The legitimate case: a personal sandbox repo with no CI configured at
    // all. The merge button SHOULD appear here — nothing to wait for.
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
        checks: expect.objectContaining({ state: "none" }),
      })],
    }));

    existsSyncSpy.mockRestore();
    poller.destroy();
  });

  it("reverts pending → none after grace window when GitHub never registers checks (paths-filter no-op)", async () => {
    // Reproduces the docs-only PR case: workflows exist in the repo, but the
    // PR's changed paths don't match any workflow's `paths:` filter, so
    // GitHub never registers a check run. Without a timeout, we'd spin the
    // CI indicator forever and the merge button would never appear.
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
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

    // First poll inside grace window — state forced to "pending".
    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

    sseBroadcast.mockClear();

    // Advance well past the grace window. GitHub still reports no checks.
    // The override should drop and we should broadcast the flip to "none",
    // which unblocks the merge button on the client.
    await vi.advanceTimersByTimeAsync(65_000);

    const noneCall = sseBroadcast.mock.calls.find(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(noneCall, "expected a broadcast flipping state to none after grace").toBeDefined();

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });

  it("resets grace window when head SHA changes (new push gives GitHub fresh time)", async () => {
    // PR starts with sha-1 / no checks, then a new commit lands at sha-2 with
    // still no checks. The grace timer should restart so we don't immediately
    // declare the new commit "no CI" — GitHub may yet register workflows.
    const sha1Node = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
    });

    const githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [sha1Node] } } },
    });
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

    // First poll: pending (within grace).
    await vi.advanceTimersByTimeAsync(0);

    // Just before grace expires, new commit lands.
    await vi.advanceTimersByTimeAsync(50_000);
    const sha2Node = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-2", statusCheckRollup: null } }] },
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [sha2Node] } } },
    });

    // Trigger a poll on the new SHA (timer + slop for promise resolution).
    await vi.advanceTimersByTimeAsync(3_000);

    sseBroadcast.mockClear();

    // 20s later (~73s since session start, but only ~23s since the SHA
    // change) — should still be "pending" because the SHA-change reset the
    // grace timer. This is the regression we want to guard against.
    await vi.advanceTimersByTimeAsync(20_000);

    const flippedToNone = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedToNone, "should not flip to none yet — SHA changed, grace restarted").toBe(false);

    // Advance past the new grace window — now flip should fire.
    await vi.advanceTimersByTimeAsync(50_000);
    const flippedNow = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedNow).toBe(true);

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });

  it("clears grace tracker when checks finally arrive — normal pending/success flow resumes", async () => {
    // PR opens with no checks (override fires), then GitHub registers a
    // pending check, then it succeeds. The grace tracker should not interfere
    // with the normal lifecycle.
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
    });
    const githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
    });
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
    // Pending (override).

    // GitHub registers an in-progress check.
    const pendingNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "sha-1",
            statusCheckRollup: {
              state: "PENDING",
              contexts: { nodes: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] },
            },
          },
        }],
      },
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [pendingNode] } } },
    });

    await vi.advanceTimersByTimeAsync(3_000);

    // Then the check succeeds, well past the original grace window. If the
    // tracker hadn't been cleared when checks first arrived, a stale "grace
    // expired" comparison could in theory misclassify state — but since
    // state !== "none" we now skip the override path entirely, so success
    // should propagate cleanly.
    const successNode = makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "sha-1",
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: { nodes: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] },
            },
          },
        }],
      },
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [successNode] } } },
    });

    sseBroadcast.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);

    const sawSuccess = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "success");
    });
    expect(sawSuccess).toBe(true);

    existsSyncSpy.mockRestore();
    readdirSyncSpy.mockRestore();
    poller.destroy();
  });
});
