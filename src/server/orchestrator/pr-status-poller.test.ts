import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, PR_STATUS_POLL_INTERVAL_MS, parsePrNode, extractHeadSha, extractFailedCheckRuns } from "./pr-status-poller.js";
import {
  PR_STATUS_QUERY,
  PR_STATUS_QUERY_WITH_CONVERSATION,
  parseConversation,
  prStatusEqual,
} from "./pr-status-parser.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import * as workflowLoader from "./workflow-loader.js";
import type { ParsedWorkflow } from "./workflow-loader.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";

// eslint-disable-next-line no-restricted-syntax -- vi.mock's importOriginal generic needs an inline import() type
vi.mock("./workflow-loader.js", async (importOriginal: () => Promise<typeof import("./workflow-loader.js")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAndParseWorkflows: vi.fn(),
  };
});

const mockLoadWorkflows = vi.mocked(workflowLoader.loadAndParseWorkflows);

/** Convenience: a parsed-workflow stub representing "any workflow, no filter." */
const ALWAYS_APPLIES: ParsedWorkflow = { alwaysApplies: true, events: [] };

// ---- Helpers ----

function makeGraphQLPrNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Add feature",
    body: "Original description",
    createdAt: "2026-05-20T10:00:00Z",
    author: { login: "alice", avatarUrl: "https://avatars/alice.png" },
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    headRefName: "shipit/abc-feature",
    baseRefName: "main",
    additions: 100,
    deletions: 20,
    files: { nodes: [{ path: "src/index.ts", additions: 7, deletions: 2, changeType: "CHANGED" }] },
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

/** Conversation selections as GitHub returns them (docs/133 Phase 4). */
const CONVERSATION_OVERRIDES = {
  comments: {
    nodes: [
      {
        id: "IC_1",
        body: "Looks good",
        createdAt: "2026-05-20T10:00:00Z",
        url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        author: { login: "alice", avatarUrl: "https://avatars/alice.png" },
      },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        id: "RT_1",
        isResolved: false,
        isOutdated: true,
        path: "src/x.ts",
        line: 12,
        comments: {
          nodes: [
            { id: "RC_1", body: "nit: rename", createdAt: "2026-05-20T10:05:00Z", author: { login: "bob", avatarUrl: "" } },
          ],
        },
      },
    ],
  },
};

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
    // Poller reads this on every tick; default to "not limited" so existing
    // tests don't need to know about the rate-limit gate.
    getRateLimitState: vi.fn().mockReturnValue({ limited: false, resetAt: null, remaining: null }),
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
      prCreatedAt: "2026-05-20T10:00:00Z",
      prAuthor: { login: "alice", avatarUrl: "https://avatars/alice.png" },
      prState: "open",
      baseBranch: "main",
      headBranch: "shipit/abc-feature",
      insertions: 100,
      deletions: 20,
      checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 },
      mergeable: "mergeable",
      autoMergeEnabled: false,
      files: [{ path: "src/index.ts", status: "M", insertions: 7, deletions: 2 }],
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

describe("parseConversation (docs/133 Phase 4)", () => {
  it("parses issue comments and review threads when present", () => {
    const { issueComments, reviewThreads } = parseConversation(
      makeGraphQLPrNode(CONVERSATION_OVERRIDES) as never,
    );
    expect(issueComments).toEqual([
      {
        id: "IC_1",
        author: { login: "alice", avatarUrl: "https://avatars/alice.png" },
        body: "Looks good",
        createdAt: "2026-05-20T10:00:00Z",
        url: "https://github.com/owner/repo/pull/42#issuecomment-1",
      },
    ]);
    expect(reviewThreads).toHaveLength(1);
    expect(reviewThreads![0]).toMatchObject({
      id: "RT_1",
      isResolved: false,
      isOutdated: true,
      path: "src/x.ts",
      line: 12,
    });
    expect(reviewThreads![0].comments[0]).toEqual({
      id: "RC_1",
      author: { login: "bob", avatarUrl: "" },
      body: "nit: rename",
      createdAt: "2026-05-20T10:05:00Z",
    });
  });

  it("leaves fields undefined when the conversation selections are absent (light query)", () => {
    const { issueComments, reviewThreads } = parseConversation(makeGraphQLPrNode() as never);
    expect(issueComments).toBeUndefined();
    expect(reviewThreads).toBeUndefined();
  });

  it("falls back to 'ghost' for comments from a deleted author", () => {
    const node = makeGraphQLPrNode({
      comments: { nodes: [{ id: "IC_2", body: "hi", createdAt: "2026-05-20T10:00:00Z", url: "u", author: null }] },
    });
    const { issueComments } = parseConversation(node as never);
    expect(issueComments![0].author).toEqual({ login: "ghost", avatarUrl: "" });
  });

  it("parsePrNode includes conversation when selected, omits it otherwise", () => {
    expect(parsePrNode(makeGraphQLPrNode(CONVERSATION_OVERRIDES) as never, "s1").issueComments).toHaveLength(1);
    expect(parsePrNode(makeGraphQLPrNode() as never, "s1").issueComments).toBeUndefined();
  });
});

describe("prStatusEqual conversation comparison (docs/133 Phase 4)", () => {
  const base = parsePrNode(makeGraphQLPrNode(CONVERSATION_OVERRIDES) as never, "s1");

  it("treats both-undefined conversation as equal", () => {
    const a = parsePrNode(makeGraphQLPrNode() as never, "s1");
    const b = parsePrNode(makeGraphQLPrNode() as never, "s1");
    expect(prStatusEqual(a, b)).toBe(true);
  });

  it("detects a defined/undefined mismatch (first fetch)", () => {
    const light = parsePrNode(makeGraphQLPrNode() as never, "s1");
    expect(prStatusEqual(light, base)).toBe(false);
  });

  it("detects a new issue comment", () => {
    const more: PrStatusSummary = {
      ...base,
      issueComments: [
        ...base.issueComments!,
        { id: "IC_2", author: { login: "alice", avatarUrl: "" }, body: "another", createdAt: "2026-05-20T11:00:00Z", url: "u2" },
      ],
    };
    expect(prStatusEqual(base, more)).toBe(false);
  });

  it("detects a thread resolve flip", () => {
    const resolved: PrStatusSummary = {
      ...base,
      reviewThreads: base.reviewThreads!.map((t) => ({ ...t, isResolved: true })),
    };
    expect(prStatusEqual(base, resolved)).toBe(false);
  });

  it("is equal when conversation is unchanged", () => {
    const same = parsePrNode(makeGraphQLPrNode(CONVERSATION_OVERRIDES) as never, "s1");
    expect(prStatusEqual(base, same)).toBe(true);
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
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("fetches conversation fields only when a session's PR tab is active (docs/133 Phase 4)", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode(CONVERSATION_OVERRIDES)] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // Initial poll uses the light query (no conversation fields).
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenLastCalledWith(PR_STATUS_QUERY, expect.anything());

    // Opening the PR tab kicks an immediate poll with the conversation query.
    poller.setPrTabActive("s1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.graphqlQuery).toHaveBeenLastCalledWith(
      PR_STATUS_QUERY_WITH_CONVERSATION,
      expect.anything(),
    );

    // Closing it returns to the light query on the next tick.
    poller.setPrTabActive("s1", false);
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.graphqlQuery).toHaveBeenLastCalledWith(PR_STATUS_QUERY, expect.anything());
  });

  it("broadcasts when the PR title changes (edited on github.com or by the agent)", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ title: "Original title" })] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    // Title edited upstream — equality must NOT swallow the change.
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ title: "Updated title" })] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenLastCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", prTitle: "Updated title" }),
      ]),
    }));
  });

  it("broadcasts when the PR body changes (edited on github.com or by the agent)", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ body: "Old description" })] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    // Description edited upstream.
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ body: "New description" })] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenLastCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", prBody: "New description" }),
      ]),
    }));
  });

  it("promotes to merged via REST verify when PR disappears from OPEN results", async () => {
    // First poll: PR exists.
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    // REST verify mock confirms the PR was actually merged (avoids the false
    // promotion path where a partial GraphQL response would wrongly mark
    // every tracked session merged).
    const mergedRestResult = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "",
      state: "closed" as const,
      merged_at: "2026-05-19T12:00:00Z",
      additions: 100,
      deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, mergedRestResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    // Second poll: PR disappeared from the bulk view. The poller now fires a
    // REST verify rather than promoting to merged synchronously.
    const withoutPr = {
      data: { repository: { pullRequests: { nodes: [] } } },
    };
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue(withoutPr);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    // Flush the REST verify's pending microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    const mergedCall = sseBroadcast.mock.calls.find(([, payload]) => {
      const updates = (payload as { updates?: { prState?: string }[] }).updates;
      return updates?.some((u) => u.prState === "merged");
    });
    expect(mergedCall).toBeDefined();
  });

  it("does NOT promote to merged when REST verify reports the PR is still open (rate-limit poisoning)", async () => {
    // Scenario: GraphQL returns an empty PR list (e.g. due to a rate-limit
    // response that slipped past header detection, or a transient hiccup).
    // The bulk view says "no PRs," REST verify says "still open." This is
    // the corruption case that previously wedged sessions until restart.
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    const stillOpenRestResult = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "",
      state: "open" as const,
      merged_at: null,
      additions: 100,
      deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, stillOpenRestResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    sseBroadcast.mockClear();

    // PR disappears from bulk view.
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    // REST verify ran but did NOT promote — no merge broadcast at all.
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);
    const promotedToMerged = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { prState?: string }[] }).updates;
      return updates?.some((u) => u.prState === "merged");
    });
    expect(promotedToMerged).toBe(false);
  });

  it("debounces REST verify: two consecutive missing-PR polls only fire one verify", async () => {
    const withoutPr = {
      data: { repository: { pullRequests: { nodes: [] } } },
    };
    const stillOpenRestResult = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "",
      state: "open" as const,
      merged_at: null,
      additions: 0,
      deletions: 0,
    };
    githubAuth = makeGitHubAuth(withoutPr, stillOpenRestResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll fires verify (the catch-up case — no prior bulk record).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    // Subsequent polls with the PR still missing should NOT re-verify —
    // `verifiedAbsent` is sticky until the PR reappears in a bulk response.
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);
  });

  it("REST verify unsticks lastKnown when it is stale-merged but the PR is actually open", async () => {
    // Setup: persisted snapshot says "merged" (the bug we're recovering
    // from), but REST verify confirms the PR is still open. The poller
    // should clear the snapshot and broadcast a removal.
    const persistedMerged = {
      sessionId: "s1",
      prNumber: 42,
      prUrl: "u",
      prTitle: "t",
      prBody: "",
      prState: "merged" as const,
      baseBranch: "main",
      headBranch: "shipit/abc-feature",
      insertions: 0,
      deletions: 0,
      checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown" as const,
      autoMergeEnabled: false,
    };
    const stillOpenRestResult = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "",
      state: "open" as const,
      merged_at: null,
      additions: 0,
      deletions: 0,
    };
    githubAuth = makeGitHubAuth(
      { data: { repository: { pullRequests: { nodes: [] } } } },
      stillOpenRestResult,
    );
    sessionManager = {
      list: () => [{
        id: "s1",
        title: "Test",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        branch: "shipit/abc-feature",
        remoteUrl: "https://github.com/owner/repo",
      }],
      get: () => undefined,
      setPrStatus: vi.fn(),
      getAllPrStatuses: vi.fn().mockReturnValue([persistedMerged]),
    } as unknown as SessionManager;

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.loadPersisted();
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.setPrStatus).toHaveBeenCalledWith("s1", null);
    expect(sseBroadcast).toHaveBeenCalledWith(
      "pr_status",
      expect.objectContaining({ updates: [], removals: ["s1"] }),
    );
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
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
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
      body: "",
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
      body: "",
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
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
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
    mockLoadWorkflows.mockReset();
    // Default: workflow detection fails (no workflows). Individual tests
    // override this to simulate parsed workflow files.
    mockLoadWorkflows.mockResolvedValue(null);
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

    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

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

    // mockLoadWorkflows defaults to null (no workflow dir).

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

    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

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

    poller.destroy();
  });

  it("skips grace immediately when no workflow's filters match the PR's changed files (docs-only PR case)", async () => {
    // Reproduces the bug: workflows exist with `paths-ignore: ['**.md']`,
    // PR changes only .md files, GitHub never registers a check. Pre-fix,
    // the user saw a 60-second spinning CI badge. With workflow parsing,
    // we know upfront that no workflow applies and skip grace entirely.
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
      files: { nodes: [{ path: "README.md" }, { path: "docs/intro.md" }] },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    // Workflow with paths-ignore that excludes the PR's changed files.
    mockLoadWorkflows.mockResolvedValue([
      {
        alwaysApplies: false,
        events: [{ pathsInclude: [], pathsIgnore: ["docs/**", "**.md"] }],
      },
    ]);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // No spinner — state should stay "none" and merge button should appear.
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "none" }),
      })],
    }));

    poller.destroy();
  });

  it("still forces pending when at least one workflow's filters match the PR's changed files", async () => {
    // Same as above but the PR also touches a src file, which matches the
    // include-list. At least one workflow would run → grace is justified.
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
      files: { nodes: [{ path: "README.md" }, { path: "src/index.ts" }] },
    });
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [noCiNode] } } },
    };

    const githubAuth = makeGitHubAuth(graphqlResult);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    mockLoadWorkflows.mockResolvedValue([
      {
        alwaysApplies: false,
        events: [{ pathsInclude: ["src/**"], pathsIgnore: [] }],
      },
    ]);

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
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

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

    // First load: bare cache has no workflows yet (fetch in progress).
    mockLoadWorkflows.mockResolvedValueOnce(null);

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
    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

    // Advance to the next poll tick.
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

    // Now the override should fire — state flips to "pending".
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

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

    // No local workflow files — only the external-CI signal matters here.

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

    // mockLoadWorkflows defaults to null (no workflows).

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

    poller.destroy();
  });

  it("reverts pending → none after grace window when GitHub never registers checks (paths-filter no-op)", async () => {
    // Reproduces the docs-only PR case from the *workflow-load-failed* path:
    // workflows couldn't be parsed (bare cache empty, YAML error, etc.) but
    // some other PR in the repo has observed checks, so we conservatively
    // force pending. Without a timeout, the spinner would run forever.
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

    // Parsed workflows say "always applies" so the changed-files short-
    // circuit doesn't fire — we exercise the time-based fallback.
    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

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

    // Advance well past the (20s) grace window. GitHub still reports no
    // checks. The override should drop and we should broadcast the flip to
    // "none", which unblocks the merge button on the client.
    await vi.advanceTimersByTimeAsync(31_000);

    const noneCall = sseBroadcast.mock.calls.find(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(noneCall, "expected a broadcast flipping state to none after grace").toBeDefined();

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

    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll: pending (within grace, observedAt=0).
    await vi.advanceTimersByTimeAsync(0);

    // 10s in — still within sha-1's 20s grace. Switch the GraphQL response
    // to return sha-2 so the next poll observes a new head SHA.
    await vi.advanceTimersByTimeAsync(10_000);
    const sha2Node = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-2", statusCheckRollup: null } }] },
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [sha2Node] } } },
    });

    // Trigger a poll on the new SHA — grace resets to observedAt=15s.
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

    sseBroadcast.mockClear();

    // 10s after the SHA change (~25s wall time, but only 10s into sha-2's
    // 20s grace) — should still be "pending" because the SHA-change reset
    // the grace timer. This is the regression we want to guard against.
    await vi.advanceTimersByTimeAsync(10_000);

    const flippedToNone = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedToNone, "should not flip to none yet — SHA changed, grace restarted").toBe(false);

    // Advance past sha-2's grace window — now flip should fire.
    await vi.advanceTimersByTimeAsync(20_000);
    const flippedNow = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedNow).toBe(true);

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

    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

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

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

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

    poller.destroy();
  });
});

describe("PrStatusPoller — GitHub rate-limit handling", () => {
  let sseBroadcast: ReturnType<typeof vi.fn<(event: string, data: unknown) => void>>;
  let poller: PrStatusPoller;

  beforeEach(() => {
    vi.useFakeTimers();
    sseBroadcast = vi.fn();
  });

  afterEach(() => {
    poller?.destroy();
    vi.useRealTimers();
  });

  it("skips polling and emits gh_rate_limited when GitHub reports a limit", async () => {
    const githubAuth = {
      authenticated: true,
      graphqlQuery: vi.fn().mockResolvedValue(null),
      findPullRequestAnyState: vi.fn(),
      getRateLimitState: vi.fn().mockReturnValue({
        limited: true,
        resetAt: Date.now() + 60_000,
        remaining: 0,
      }),
    } as unknown as GitHubAuthManager;
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    // No GraphQL call because the poller saw `limited: true` first.
    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
    // Banner event fired exactly once on entering limited state.
    const rateLimitedCalls = sseBroadcast.mock.calls.filter(([event]) => event === "gh_rate_limited");
    expect(rateLimitedCalls).toHaveLength(1);
    expect(rateLimitedCalls[0][1]).toMatchObject({ resetAt: expect.any(Number) });

    // Subsequent ticks while still limited should NOT re-broadcast (debounce
    // on entering the state).
    await vi.advanceTimersByTimeAsync(10_000);
    const stillOnceRateLimited = sseBroadcast.mock.calls.filter(([event]) => event === "gh_rate_limited");
    expect(stillOnceRateLimited).toHaveLength(1);
  });

  it("emits gh_rate_limited_cleared when the limit lifts", async () => {
    let limited = true;
    const githubAuth = {
      authenticated: true,
      graphqlQuery: vi.fn().mockResolvedValue({
        data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
      }),
      findPullRequestAnyState: vi.fn(),
      getRateLimitState: vi.fn().mockImplementation(() => ({
        limited,
        resetAt: limited ? Date.now() + 60_000 : null,
        remaining: limited ? 0 : 4999,
      })),
    } as unknown as GitHubAuthManager;
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast.mock.calls.some(([event]) => event === "gh_rate_limited")).toBe(true);

    // Limit lifts — next tick should clear and resume.
    limited = false;
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

    const clearedCalls = sseBroadcast.mock.calls.filter(([event]) => event === "gh_rate_limited_cleared");
    expect(clearedCalls).toHaveLength(1);
    // And a normal pr_status broadcast follows.
    const prStatusCalls = sseBroadcast.mock.calls.filter(([event]) => event === "pr_status");
    expect(prStatusCalls.length).toBeGreaterThan(0);
  });

  it("loadPersisted does NOT seed mergedSessions from a persisted merged snapshot", async () => {
    // This is the key recovery behavior: if the previous process wrote a
    // merged status (potentially from a rate-limit-induced false promotion),
    // we don't trust it. The first poll's REST verify gets the final say.
    const persistedMerged = {
      sessionId: "s1",
      prNumber: 42,
      prUrl: "u",
      prTitle: "t",
      prBody: "",
      prState: "merged" as const,
      baseBranch: "main",
      headBranch: "shipit/abc-feature",
      insertions: 0,
      deletions: 0,
      checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown" as const,
      autoMergeEnabled: false,
    };
    const stillOpen = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "",
      state: "open" as const,
      merged_at: null,
      additions: 0,
      deletions: 0,
    };
    const githubAuth = {
      authenticated: true,
      graphqlQuery: vi.fn().mockResolvedValue({
        data: { repository: { pullRequests: { nodes: [] } } },
      }),
      findPullRequestAnyState: vi.fn().mockResolvedValue(stillOpen),
      getRateLimitState: vi.fn().mockReturnValue({ limited: false, resetAt: null, remaining: null }),
    } as unknown as GitHubAuthManager;
    const sessionManager = {
      list: () => [{
        id: "s1",
        title: "Test",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        branch: "shipit/abc-feature",
        remoteUrl: "https://github.com/owner/repo",
      }],
      get: () => undefined,
      setPrStatus: vi.fn(),
      getAllPrStatuses: vi.fn().mockReturnValue([persistedMerged]),
    } as unknown as SessionManager;

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.loadPersisted();
    poller.trackSession("s1", "https://github.com/owner/repo");

    // First poll iterates s1 (not skipped — it's not in mergedSessions anymore),
    // sees PR missing from bulk, fires verify.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalled();
  });
});
