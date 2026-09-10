import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrStatusPoller, PR_STATUS_POLL_INTERVAL_MS, PR_STATUS_SLOW_INTERVAL_MS, parsePrNode, extractHeadSha, extractBaseSha, extractFailedCheckRuns } from "./pr-status-poller.js";
import {
  buildPrStatusQuery,
  extractFocusedPrNodes,
  parseConversation,
  prStatusEqual,
} from "./pr-status-parser.js";
import type { PrStatusSummary } from "../shared/types/github-types.js";
import { noteMergePerformed, resetMergeAttribution } from "./services/merge-attribution.js";
import * as workflowLoader from "./workflow-loader.js";
import { NO_CHECKS_GRACE_MS } from "./ci-grace-tracker.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { GitManager } from "../shared/git.js";
import {
  makeFakeRegistry,
  makeGraphQLPrNode,
  makeSessionManager,
  makeGitHubAuth,
  ALWAYS_APPLIES,
  CONVERSATION_OVERRIDES,
} from "./pr-poller-test-helpers.js";

// eslint-disable-next-line no-restricted-syntax -- vi.mock's importOriginal generic needs an inline import() type
vi.mock("./workflow-loader.js", async (importOriginal: () => Promise<typeof import("./workflow-loader.js")>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAndParseWorkflows: vi.fn(),
  };
});

const mockLoadWorkflows = vi.mocked(workflowLoader.loadAndParseWorkflows);

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

  it.each([
    ["APPROVED", "approved"],
    ["CHANGES_REQUESTED", "changes_requested"],
    ["REVIEW_REQUIRED", "review_required"],
    [null, "none"],
    ["SOMETHING_NEW", "none"],
  ] as const)("maps GraphQL reviewDecision %s to \"%s\"", (input, expected) => {
    const node = makeGraphQLPrNode({ reviewDecision: input });
    const result = parsePrNode(node as never, "session-1");
    expect(result.reviewDecision).toBe(expected);
  });

  it("defaults reviewDecision to \"none\" when the field is absent", () => {
    const result = parsePrNode(makeGraphQLPrNode() as never, "session-1");
    expect(result.reviewDecision).toBe("none");
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

  it("detects a reviewDecision change so a fresh approval rebroadcasts (docs/174)", () => {
    const required = parsePrNode(makeGraphQLPrNode({ reviewDecision: "REVIEW_REQUIRED" }) as never, "s1");
    const approved = parsePrNode(makeGraphQLPrNode({ reviewDecision: "APPROVED" }) as never, "s1");
    expect(prStatusEqual(required, approved)).toBe(false);
  });

  it("is equal when conversation is unchanged", () => {
    const same = parsePrNode(makeGraphQLPrNode(CONVERSATION_OVERRIDES) as never, "s1");
    expect(prStatusEqual(base, same)).toBe(true);
  });
});

describe("buildPrStatusQuery (docs/155 Phase 1)", () => {
  it("emits a bulk pullRequests connection with light fields only", () => {
    const query = buildPrStatusQuery({ first: 7 });
    expect(query).toContain("pullRequests(first: 7, states: [OPEN]");
    expect(query).not.toContain("reviewThreads");
    expect(query).not.toContain("focused");
    expect(query).not.toContain("coverage");
  });

  it("orders the bulk connection by UPDATED_AT DESC so the window is biased to active PRs", () => {
    const query = buildPrStatusQuery({ first: 7 });
    expect(query).toContain("orderBy: { field: UPDATED_AT, direction: DESC }");
  });

  it("appends one focused alias per focusedPrNumber, each carrying conversation", () => {
    const query = buildPrStatusQuery({ first: 5, focusedPrNumbers: [42, 99] });
    expect(query).toContain("focused0: pullRequest(number: 42)");
    expect(query).toContain("focused1: pullRequest(number: 99)");
    const reviewThreadOccurrences = query.match(/reviewThreads/g)?.length ?? 0;
    expect(reviewThreadOccurrences).toBe(2);
  });

  it("appends one light coverage alias per coveragePrNumber, no conversation", () => {
    const query = buildPrStatusQuery({ first: 5, coveragePrNumbers: [7, 8] });
    expect(query).toContain("coverage0: pullRequest(number: 7)");
    expect(query).toContain("coverage1: pullRequest(number: 8)");
    expect(query).not.toContain("reviewThreads");
  });

  it("does not emit a duplicate coverage alias for a PR already focused", () => {
    const query = buildPrStatusQuery({ first: 5, focusedPrNumbers: [42], coveragePrNumbers: [42, 99] });
    expect(query).toContain("focused0: pullRequest(number: 42)");
    expect(query).toContain("coverage0: pullRequest(number: 99)");
    const occurrences42 = query.match(/pullRequest\(number: 42\)/g)?.length ?? 0;
    expect(occurrences42).toBe(1);
  });
});

describe("extractFocusedPrNodes (docs/155 Phase 1)", () => {
  it("returns an empty map when the response has no focused aliases", () => {
    const result = { data: { repository: { pullRequests: { nodes: [] } } } };
    expect(extractFocusedPrNodes(result).size).toBe(0);
  });

  it("indexes focused aliases by PR number", () => {
    const result = {
      data: {
        repository: {
          pullRequests: { nodes: [] },
          focused0: { number: 42, title: "PR 42" },
          focused1: { number: 99, title: "PR 99" },
        },
      },
    };
    const map = extractFocusedPrNodes(result);
    expect(map.size).toBe(2);
    expect((map.get(42) as { title: string }).title).toBe("PR 42");
    expect((map.get(99) as { title: string }).title).toBe("PR 99");
  });

  it("ignores non-focused keys and malformed values", () => {
    const result = {
      data: {
        repository: {
          pullRequests: { nodes: [] },
          focused0: { number: 7 },
          focused_bad: null,
          notFocused: { number: 99 },
        },
      },
    };
    const map = extractFocusedPrNodes(result);
    expect(map.size).toBe(1);
    expect(map.has(7)).toBe(true);
    expect(map.has(99)).toBe(false);
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

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("force-refreshes a session even when idle polling would skip", async () => {
    githubAuth = makeGitHubAuth({
      data: {
        repository: {
          pullRequests: {
            nodes: [makeGraphQLPrNode({ title: "Original title" })],
          },
        },
      },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        repository: {
          pullRequests: {
            nodes: [makeGraphQLPrNode({ title: "Updated while idle" })],
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);

    await poller.forceRefreshSession("s1");

    expect(sseBroadcast).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenLastCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId: "s1", prTitle: "Updated while idle" })],
    }));
  });

  it("emits a focused alias only for the active-PR-tab session (docs/155 Phase 1b)", async () => {
    const graphqlResult = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode(CONVERSATION_OVERRIDES)] } } },
    };
    githubAuth = makeGitHubAuth(graphqlResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;

    await vi.advanceTimersByTimeAsync(0);
    const initialQuery = calls.mock.calls.at(-1)?.[0] as string;
    expect(initialQuery).toMatch(/pullRequests\(first: \d+, states: \[OPEN\]/);
    expect(initialQuery).not.toContain("focused");
    expect(initialQuery).not.toContain("reviewThreads");

    poller.setPrTabActive("s1", true);
    await vi.advanceTimersByTimeAsync(0);
    const focusedQuery = calls.mock.calls.at(-1)?.[0] as string;
    expect(focusedQuery).toContain("focused0: pullRequest(number: 42)");
    expect(focusedQuery).toContain("reviewThreads");

    poller.setPrTabActive("s1", false);
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    const settledQuery = calls.mock.calls.at(-1)?.[0] as string;
    expect(settledQuery).not.toContain("focused");
    expect(settledQuery).not.toContain("reviewThreads");
  });

  it("caps bulk first:N to tracked-session count with a discovery floor (docs/155 Phase 1a)", async () => {
    githubAuth = makeGitHubAuth({ data: { repository: { pullRequests: { nodes: [] } } } });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;
    const query = calls.mock.calls.at(-1)?.[0] as string;
    expect(query).toMatch(/pullRequests\(first: 5, states: \[OPEN\]/);
  });

  it("scales bulk first:N up with tracked-session count (docs/155 Phase 1a)", async () => {
    githubAuth = makeGitHubAuth({ data: { repository: { pullRequests: { nodes: [] } } } });
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      branch: `shipit/abc-${i}`,
      remoteUrl: "https://github.com/owner/repo",
    }));
    sessionManager = makeSessionManager(sessions);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    for (const s of sessions) poller.trackSession(s.id, "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;
    const query = calls.mock.calls.at(-1)?.[0] as string;
    expect(query).toMatch(/pullRequests\(first: 10, states: \[OPEN\]/);
  });

  it("caps bulk first:N at 30 even when tracked sessions exceed it (docs/155 Phase 1a)", async () => {
    githubAuth = makeGitHubAuth({ data: { repository: { pullRequests: { nodes: [] } } } });
    const sessions = Array.from({ length: 50 }, (_, i) => ({
      id: `s${i}`,
      branch: `shipit/abc-${i}`,
      remoteUrl: "https://github.com/owner/repo",
    }));
    sessionManager = makeSessionManager(sessions);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    for (const s of sessions) poller.trackSession(s.id, "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;
    const query = calls.mock.calls.at(-1)?.[0] as string;
    expect(query).toMatch(/pullRequests\(first: 30, states: \[OPEN\]/);
  });

  it("aliases every tracked session's known PR by number for coverage (discovery fix)", async () => {
    githubAuth = makeGitHubAuth({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              makeGraphQLPrNode({ number: 42, headRefName: "shipit/abc-feature" }),
              makeGraphQLPrNode({ number: 43, headRefName: "shipit/def-feature" }),
            ],
          },
        },
      },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      { id: "s2", branch: "shipit/def-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");
    poller.trackSession("s2", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    await poller.forceRefreshSession("s1");
    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;
    const secondQuery = calls.mock.calls.at(-1)?.[0] as string;
    expect(secondQuery).toContain("pullRequest(number: 42)");
    expect(secondQuery).toContain("pullRequest(number: 43)");
  });

  it("surfaces a tracked open PR via its coverage alias when it falls outside the bulk window (discovery fix)", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([expect.objectContaining({ sessionId: "s1", prNumber: 42 })]),
    }));

    const calls = githubAuth.graphqlQuery as ReturnType<typeof vi.fn>;

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        repository: {
          pullRequests: {
            nodes: [makeGraphQLPrNode({ number: 7, headRefName: "shipit/other", title: "Unrelated PR" })],
          },
          coverage0: makeGraphQLPrNode({ title: "Still open on a busy repo" }),
        },
      },
    });

    await poller.forceRefreshSession("s1");

    const secondQuery = calls.mock.calls.at(-1)?.[0] as string;
    expect(secondQuery).toContain("coverage0: pullRequest(number: 42)");

    expect(githubAuth.findPullRequestAnyState).not.toHaveBeenCalled();
    expect(sseBroadcast).toHaveBeenLastCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({
          sessionId: "s1",
          prNumber: 42,
          prState: "open",
          prTitle: "Still open on a busy repo",
        }),
      ]),
    }));
  });

  it("does not surface a merged PR through its coverage alias — merged detection still owns terminal state (discovery fix)", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      title: "Add feature",
      body: "Original description",
      state: "closed",
      merged_at: "2026-05-21T10:00:00Z",
      base: "main",
      additions: 100,
      deletions: 20,
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        repository: {
          pullRequests: { nodes: [] },
          coverage0: makeGraphQLPrNode({ state: "MERGED" }),
        },
      },
    });

    await poller.forceRefreshSession("s1", { waitForMissingVerify: true });

    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalled();
    expect(poller.getStatus("s1")?.prState).toBe("merged");
  });

  describe("docs/218: merged head SHA capture (auto-reset anchor)", () => {
    function mergedRestResult(headSha: string | null) {
      return {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        title: "Add feature",
        body: "Original description",
        state: "closed" as const,
        merged_at: "2026-05-21T10:00:00Z",
        merge_commit_sha: "mergecommitsha",
        head_sha: headSha,
        base: "main",
        additions: 100,
        deletions: 20,
      };
    }

    it("records the merged PR's head.sha as the session's mergedHeadSha", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        mergedRestResult("headtipsha123"),
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/owner/repo");

      await poller.forceRefreshSession("s1", { waitForMissingVerify: true });

      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(sessionManager.setMergedHeadSha).toHaveBeenCalledWith("s1", "headtipsha123");
    });

    it("fails closed (no anchor recorded) when the merged PR has no head.sha", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        mergedRestResult(null),
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/owner/repo");

      await poller.forceRefreshSession("s1", { waitForMissingVerify: true });

      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
    });
  });

  describe("repo transfer canonical-owner targeting", () => {
    it("uses the canonical owner for the REST merge probe and detects the merge", async () => {
      githubAuth = makeGitHubAuth({
        data: {
          repository: {
            nameWithOwner: "nikzlabs/shipit",
            pullRequests: { nodes: [] },
          },
        },
      });
      (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        url: "https://github.com/nikzlabs/shipit/pull/42",
        title: "Add feature",
        body: "Original description",
        state: "closed",
        merged_at: "2026-05-21T10:00:00Z",
        merge_commit_sha: "deadbeef",
        base: "main",
        additions: 100,
        deletions: 20,
      });
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/nicolasalt/shipit.git" },
      ]);

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/nicolasalt/shipit.git");
      await poller.forceRefreshSession("s1", { waitForMissingVerify: true });

      expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledWith(
        "nikzlabs",
        "shipit",
        "shipit/abc-feature",
      );
      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(sessionManager.setRemoteUrl).not.toHaveBeenCalled();
    });

    it("uses the canonical owner for the post-merge fast-path verify (forceVerifySessionPrState)", async () => {
      githubAuth = makeGitHubAuth({
        data: {
          repository: {
            nameWithOwner: "nikzlabs/shipit",
            pullRequests: { nodes: [] },
          },
        },
      });
      (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mockResolvedValue({
        number: 42,
        url: "https://github.com/nikzlabs/shipit/pull/42",
        title: "Add feature",
        body: "Original description",
        state: "closed",
        merged_at: "2026-05-21T10:00:00Z",
        merge_commit_sha: "deadbeef",
        base: "main",
        additions: 100,
        deletions: 20,
      });
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/nicolasalt/shipit.git" },
      ]);

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/nicolasalt/shipit.git");
      await poller.forceVerifySessionPrState("s1");

      expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledWith(
        "nikzlabs",
        "shipit",
        "shipit/abc-feature",
      );
      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(sessionManager.setRemoteUrl).not.toHaveBeenCalled();
    });

    it("is a no-op when nameWithOwner matches the polled key", async () => {
      githubAuth = makeGitHubAuth({
        data: {
          repository: {
            nameWithOwner: "owner/repo",
            pullRequests: { nodes: [makeGraphQLPrNode()] },
          },
        },
      });
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/owner/repo");
      await vi.advanceTimersByTimeAsync(0);

      expect(sessionManager.setRemoteUrl).not.toHaveBeenCalled();
      expect(poller.getStatus("s1")?.prState).toBe("open");
    });
  });

  describe("re-arm superseded-PR suppression", () => {
    const SUPERSEDED_MERGED = {
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      title: "Add feature",
      body: "Original description",
      state: "closed",
      merged_at: "2026-05-21T10:00:00Z",
      base: "main",
      additions: 100,
      deletions: 20,
    };

    it("does NOT re-promote the superseded merged PR after reArm (suppression holds)", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        SUPERSEDED_MERGED,
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });

      poller.reArm("s1", 42);
      await vi.advanceTimersByTimeAsync(0);
      await poller.forceVerifySessionPrState("s1");

      expect(poller.getStatus("s1")).toBeUndefined();
      const promotedMerged = sseBroadcast.mock.calls.some(
        ([event, payload]) =>
          event === "pr_status" &&
          (payload as { updates?: { prState?: string }[] }).updates?.some((u) => u.prState === "merged"),
      );
      expect(promotedMerged).toBe(false);
    });

    it("clears the suppression and tracks normally once a different-numbered PR appears", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        SUPERSEDED_MERGED,
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });

      poller.reArm("s1", 42);
      await vi.advanceTimersByTimeAsync(0);
      await poller.forceVerifySessionPrState("s1");
      expect(poller.getStatus("s1")).toBeUndefined();

      (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          repository: {
            pullRequests: { nodes: [makeGraphQLPrNode({ number: 99, state: "OPEN" })] },
          },
        },
      });
      await poller.forceRefreshSession("s1");
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.getStatus("s1")?.prState).toBe("open");
      expect(poller.getStatus("s1")?.prNumber).toBe(99);
    });

    it("converges to merged when the NEW PR opens and merges between polls (never seen open)", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        SUPERSEDED_MERGED,
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });

      poller.reArm("s1", 42);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.getStatus("s1")).toBeUndefined();

      (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mockResolvedValue({
        url: "https://github.com/owner/repo/pull/99",
        number: 99,
        base: "main",
        title: "Next slice",
        body: "",
        state: "closed" as const,
        merged_at: "2026-05-22T10:00:00Z",
        merge_commit_sha: "mergesha99",
        head_sha: "headsha99",
        additions: 5,
        deletions: 1,
      });

      await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(poller.getStatus("s1")?.prNumber).toBe(99);
    });

    it("reArm broadcasts no destructive pr_status removal", async () => {
      githubAuth = makeGitHubAuth(
        { data: { repository: { pullRequests: { nodes: [] } } } },
        SUPERSEDED_MERGED,
      );
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });

      poller.reArm("s1", 42);
      await vi.advanceTimersByTimeAsync(0);

      const sentRemoval = sseBroadcast.mock.calls.some(
        ([event, payload]) =>
          event === "pr_status" && Array.isArray((payload as { removals?: string[] }).removals) &&
          ((payload as { removals?: string[] }).removals?.length ?? 0) > 0,
      );
      expect(sentRemoval).toBe(false);
    });
  });

  it("preserves cached conversation when the PR tab loses focus mid-cycle (docs/155 Phase 1b)", async () => {
    const heavyNode = makeGraphQLPrNode(CONVERSATION_OVERRIDES);
    const lightNode = makeGraphQLPrNode();

    githubAuth = makeGitHubAuth({
      data: {
        repository: {
          pullRequests: { nodes: [lightNode] },
          focused0: heavyNode,
        },
      },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    poller.setPrTabActive("s1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getStatus("s1")?.issueComments).toHaveLength(1);
    expect(poller.getStatus("s1")?.reviewThreads).toHaveLength(1);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [lightNode] } } },
    });
    poller.setPrTabActive("s1", false);
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);

    expect(poller.getStatus("s1")?.issueComments).toHaveLength(1);
    expect(poller.getStatus("s1")?.reviewThreads).toHaveLength(1);
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

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ title: "Updated title" })] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
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

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ body: "New description" })] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    expect(sseBroadcast).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenLastCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", prBody: "New description" }),
      ]),
    }));
  });

  it("overrides GitHub additions/deletions with locally-computed diff stats when createGitManager is wired", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ additions: 100, deletions: 20 })] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo", workspaceDir: "/sessions/s1" },
    ]);

    const diffStatVsBranch = vi.fn().mockResolvedValue({ insertions: 250, deletions: 50 });
    const createGitManager = vi.fn().mockReturnValue({ diffStatVsBranch });

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      createGitManager: createGitManager as unknown as (dir: string) => GitManager,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(createGitManager).toHaveBeenCalledWith("/sessions/s1");
    expect(diffStatVsBranch).toHaveBeenCalledWith("main");
    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", insertions: 250, deletions: 50 }),
      ]),
    }));
  });

  it("falls back to GitHub additions/deletions when local diff throws (archived workspace, etc.)", async () => {
    githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode({ additions: 100, deletions: 20 })] } } },
    });
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo", workspaceDir: "/gone" },
    ]);

    const diffStatVsBranch = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const createGitManager = vi.fn().mockReturnValue({ diffStatVsBranch });

    poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      createGitManager: createGitManager as unknown as (dir: string) => GitManager,
    });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: expect.arrayContaining([
        expect.objectContaining({ sessionId: "s1", insertions: 100, deletions: 20 }),
      ]),
    }));
  });

  it("promotes to merged via REST verify when PR disappears from OPEN results", async () => {
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
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

    const withoutPr = {
      data: { repository: { pullRequests: { nodes: [] } } },
    };
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue(withoutPr);

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    const mergedCall = sseBroadcast.mock.calls.find(([, payload]) => {
      const updates = (payload as { updates?: { prState?: string }[] }).updates;
      return updates?.some((u) => u.prState === "merged");
    });
    expect(mergedCall).toBeDefined();
  });

  it("fires onMergedPr with the merged PR body (docs/194 issue-lifecycle)", async () => {
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    const mergedRestResult = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      base: "main",
      title: "Add feature",
      body: "## Summary\nDone.\n\nCloses SHI-9",
      state: "closed" as const,
      merged_at: "2026-05-19T12:00:00Z",
      additions: 100,
      deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, mergedRestResult);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const onMergedPr = vi.fn().mockResolvedValue(undefined);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergedPr });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(onMergedPr).toHaveBeenCalledTimes(1);
    expect(onMergedPr).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
        body: "## Summary\nDone.\n\nCloses SHI-9",
      }),
    );
  });

  it("does NOT re-fire the merge callback after trackSession re-attaches an already-merged session (docs/194)", async () => {
    const withPr = {
      data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
    };
    const mergedRest = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42, base: "main", title: "Add feature", body: "Closes SHI-9",
      state: "closed" as const, merged_at: "2026-05-19T12:00:00Z",
      additions: 100, deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, mergedRest);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    const applied = new Set<string>();
    let effectRuns = 0;
    const onMergedPr = vi.fn(async (info: { sessionId: string; prNumber: number }) => {
      const key = `${info.sessionId}:${info.prNumber}`;
      if (applied.has(key)) return;
      applied.add(key);
      effectRuns++;
    });

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergedPr });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(effectRuns).toBe(1);
    const callsAfterMerge = onMergedPr.mock.calls.length;

    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(onMergedPr.mock.calls.length).toBe(callsAfterMerge);
    expect(effectRuns).toBe(1);
  });

  it("fires onPrTerminalState with outcome 'merged' when a PR merges (docs/196)", async () => {
    const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
    const mergedRest = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42, base: "main", title: "Add feature", body: "x",
      state: "closed" as const, merged_at: "2026-05-19T12:00:00Z",
      merge_commit_sha: "abc123def456789", additions: 100, deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, mergedRest);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const onPrTerminalState = vi.fn().mockResolvedValue(undefined);
    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onPrTerminalState });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(onPrTerminalState).toHaveBeenCalledTimes(1);
    expect(onPrTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1", outcome: "merged", prNumber: 42,
        branch: "shipit/abc-feature", mergeSha: "abc123def456789",
      }),
    );
  });

  describe("the merge record for a merge performed outside ShipIt", () => {
    function mergeLines(log: { mock: { calls: unknown[][] } }): string[] {
      return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Merged PR #"));
    }

    async function observeAMerge(): Promise<void> {
      const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
      const mergedRest = {
        url: "https://github.com/owner/repo/pull/42",
        number: 42, base: "main", title: "Add feature", body: "x",
        state: "closed" as const, merged_at: "2026-05-19T12:00:00Z",
        merge_commit_sha: "abc123def456789", head_sha: "headsha1", additions: 1, deletions: 0,
      };
      githubAuth = makeGitHubAuth(withPr, mergedRest);
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/owner/repo");
      await vi.advanceTimersByTimeAsync(0);

      (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { repository: { pullRequests: { nodes: [] } } },
      });
      await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("says the merge was observed, not performed here", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await observeAMerge();
        expect(mergeLines(log)).toEqual([
          "[pr-poller] Merged PR #42 (owner/repo) for s1"
          + " via a merge no ShipIt path recorded (observed, not performed by this orchestrator process)",
        ]);
      } finally {
        log.mockRestore();
      }
    });

    it("stays silent when a ShipIt path performed this merge", async () => {
      resetMergeAttribution();
      noteMergePerformed("owner", "repo", 42);
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await observeAMerge();
        expect(mergeLines(log)).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });

    it("records the merge once across a re-track", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        await observeAMerge();
        const verifiesAfterMerge =
          (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mock.calls.length;

        poller.trackSession("s1", "https://github.com/owner/repo");
        await vi.advanceTimersByTimeAsync(0);

        expect((githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mock.calls.length)
          .toBeGreaterThan(verifiesAfterMerge);
        expect(mergeLines(log)).toHaveLength(1);
      } finally {
        log.mockRestore();
      }
    });

    it("records nothing when the PR was closed unmerged", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
        const closedRest = {
          url: "https://github.com/owner/repo/pull/42",
          number: 42, base: "main", title: "Add feature", body: "x",
          state: "closed" as const, merged_at: null, merge_commit_sha: null,
          additions: 1, deletions: 0,
        };
        githubAuth = makeGitHubAuth(withPr, closedRest);
        sessionManager = makeSessionManager([
          { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
        ]);
        poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
        poller.trackSession("s1", "https://github.com/owner/repo");
        await vi.advanceTimersByTimeAsync(0);
        (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
          data: { repository: { pullRequests: { nodes: [] } } },
        });
        await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(0);

        expect(mergeLines(log)).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });
  });

  it("fires onPrTerminalState with outcome 'closed' when a PR closes unmerged (docs/196)", async () => {
    const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
    const closedRest = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42, base: "main", title: "Add feature", body: "x",
      state: "closed" as const, merged_at: null, merge_commit_sha: null,
      additions: 100, deletions: 20,
    };
    githubAuth = makeGitHubAuth(withPr, closedRest);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const onPrTerminalState = vi.fn().mockResolvedValue(undefined);
    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onPrTerminalState });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(onPrTerminalState).toHaveBeenCalledTimes(1);
    expect(onPrTerminalState).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", outcome: "closed", prNumber: 42 }),
    );
  });

  describe("managed auto-merge and a busy session", () => {
    async function pollGreenPr(opts: { busy: boolean }) {
      const githubAuth = makeGitHubAuth({
        data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
      });
      const sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      const registry = makeFakeRegistry();
      registry.setViewers("s1", 1);
      // Model post-turn work: running is false while uncommitted edits keep it busy.
      registry.setRunning("s1", false);
      registry.setBusy("s1", opts.busy);
      const poller = new PrStatusPoller({
        githubAuth,
        sessionManager,
        sseBroadcast: vi.fn(),
        runnerRegistry: registry,
      });
      poller.setAutoMergeEnabled("s1", true);
      poller.setAutoMergeManaged("s1", true, { managedReason: "session-live" });
      poller.trackSession("s1", "https://github.com/owner/repo");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      return { poller, registry, mergePullRequest: githubAuth.mergePullRequest as ReturnType<typeof vi.fn> };
    }

    it("still merges an armed PR after its session is archived", async () => {
      vi.useFakeTimers();
      const githubAuth = makeGitHubAuth({
        data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } },
      });
      const sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo", archived: true },
      ]);
      const registry = makeFakeRegistry();
      registry.setViewers("s1", 1);
      const poller = new PrStatusPoller({
        githubAuth,
        sessionManager,
        sseBroadcast: vi.fn(),
        runnerRegistry: registry,
      });
      poller.setAutoMergeEnabled("s1", true);
      poller.setAutoMergeManaged("s1", true, { managedReason: "session-live" });
      poller.trackSession("s1", "https://github.com/owner/repo");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(githubAuth.mergePullRequest).toHaveBeenCalledTimes(1);
      poller.destroy();
      vi.useRealTimers();
    });

    it("does not merge while the session is busy, and merges once it is idle", async () => {
      vi.useFakeTimers();
      const { poller, registry, mergePullRequest } = await pollGreenPr({ busy: true });

      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(poller.getAutoMergeState("s1")?.enabled).toBe(true);
      expect(poller.getAutoMergeState("s1")?.error).toBeUndefined();

      registry.setBusy("s1", false);
      await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      poller.destroy();
      vi.useRealTimers();
    });
  });

  describe("clears auto-merge arming when the PR goes terminal", () => {
    async function pollUntilTerminal(restResult: unknown) {
      const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
      githubAuth = makeGitHubAuth(withPr, restResult);
      sessionManager = makeSessionManager([
        { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
      ]);
      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.trackSession("s1", "https://github.com/owner/repo");
      await vi.advanceTimersByTimeAsync(0);

      poller.setAutoMergeEnabled("s1", true);
      poller.setAutoMergeManaged("s1", true, {
        settingsUrl: "https://github.com/owner/repo/settings",
        reason: "Allow auto-merge is off",
      });
      expect(poller.getAutoMergeState("s1")?.enabled).toBe(true);

      (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { repository: { pullRequests: { nodes: [] } } },
      });
      await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
    }

    it("drops the state on merge", async () => {
      await pollUntilTerminal({
        url: "https://github.com/owner/repo/pull/42",
        number: 42, base: "main", title: "Add feature", body: "x",
        state: "closed" as const, merged_at: "2026-05-19T12:00:00Z",
        merge_commit_sha: "abc123", additions: 100, deletions: 20,
      });

      expect(poller.getStatus("s1")?.prState).toBe("merged");
      expect(poller.getAutoMergeState("s1")).toBeUndefined();
    });

    it("drops the state on close-without-merge", async () => {
      await pollUntilTerminal({
        url: "https://github.com/owner/repo/pull/42",
        number: 42, base: "main", title: "Add feature", body: "x",
        state: "closed" as const, merged_at: null, merge_commit_sha: null,
        additions: 100, deletions: 20,
      });

      expect(poller.getStatus("s1")?.prState).toBe("closed");
      expect(poller.getAutoMergeState("s1")).toBeUndefined();
    });
  });

  it("does NOT promote to merged when REST verify reports the PR is still open (rate-limit poisoning)", async () => {
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

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

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

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);
  });

  it("surfaces a brand-new open PR from REST when the bulk GraphQL view hasn't indexed it yet", async () => {
    const withoutPr = {
      data: { repository: { pullRequests: { nodes: [] } } },
    };
    const freshlyCreatedPr = {
      url: "https://github.com/owner/repo/pull/99",
      number: 99,
      base: "main",
      title: "Add the widget",
      body: "## Summary\nAdds a widget.",
      state: "open" as const,
      merged_at: null,
      additions: 42,
      deletions: 3,
    };
    githubAuth = makeGitHubAuth(withoutPr, freshlyCreatedPr);
    sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);

    poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.setPrStatus).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ sessionId: "s1", prNumber: 99, prState: "open" }),
    );
    expect(sseBroadcast).toHaveBeenCalledWith(
      "pr_status",
      expect.objectContaining({
        updates: [expect.objectContaining({ prNumber: 99, prState: "open" })],
      }),
    );
    expect(poller.getStatus("s1")).toMatchObject({ prNumber: 99, prState: "open" });
  });

  it("REST verify surfaces the open PR when lastKnown is stale-merged but the PR is actually open", async () => {
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

    expect(sessionManager.setPrStatus).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ sessionId: "s1", prNumber: 42, prState: "open" }),
    );
    expect(sseBroadcast).toHaveBeenCalledWith(
      "pr_status",
      expect.objectContaining({
        updates: [expect.objectContaining({ sessionId: "s1", prNumber: 42, prState: "open" })],
      }),
    );
    expect(poller.getStatus("s1")).toMatchObject({ prState: "open" });
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

    it.each(["merged", "closed"] as const)(
      "never attaches auto-merge state onto a %s summary",
      (prState) => {
        const persisted = [{
          sessionId: "s1",
          prNumber: 7,
          prUrl: "u",
          prTitle: "t",
          prState,
          baseBranch: "main",
          headBranch: "h",
          insertions: 0,
          deletions: 0,
          checks: { state: "success" as const, total: 1, passed: 1, failed: 0, pending: 0 },
          mergeable: "unknown" as const,
          autoMergeEnabled: false,
        }];
        githubAuth = makeGitHubAuth();
        sessionManager = {
          list: () => [],
          get: () => undefined,
          setPrStatus: vi.fn(),
          getAllPrStatuses: vi.fn().mockReturnValue(persisted),
        } as unknown as SessionManager;

        poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
        poller.loadPersisted();
        poller.setAutoMergeEnabled("s1", true);

        expect(poller.getAutoMergeState("s1")?.enabled).toBe(true);
        expect(poller.getAllStatuses()[0].autoMerge).toBeUndefined();
      },
    );

    it("attaches auto-merge state onto an open summary", () => {
      const persisted = [{
        sessionId: "s1",
        prNumber: 7,
        prUrl: "u",
        prTitle: "t",
        prState: "open" as const,
        baseBranch: "main",
        headBranch: "h",
        insertions: 0,
        deletions: 0,
        checks: { state: "success" as const, total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: "unknown" as const,
        autoMergeEnabled: false,
      }];
      githubAuth = makeGitHubAuth();
      sessionManager = {
        list: () => [],
        get: () => undefined,
        setPrStatus: vi.fn(),
        getAllPrStatuses: vi.fn().mockReturnValue(persisted),
      } as unknown as SessionManager;

      poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
      poller.loadPersisted();
      poller.setAutoMergeEnabled("s1", true);

      expect(poller.getAllStatuses()[0].autoMerge?.enabled).toBe(true);
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

describe("extractBaseSha", () => {
  it("returns baseRefOid from the PR node", () => {
    const node = makeGraphQLPrNode({ baseRefOid: "base456" });
    expect(extractBaseSha(node as never)).toBe("base456");
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

  function makeFailingNode() {
    return makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "sha-fail",
            statusCheckRollup: {
              state: "FAILURE",
              contexts: {
                nodes: [
                  { databaseId: 1, name: "test", status: "COMPLETED", conclusion: "FAILURE", title: "3 tests failed", detailsUrl: "https://example.com" },
                ],
              },
            },
          },
        }],
      },
    });
  }

  function makePassingNode() {
    return makeGraphQLPrNode({
      commits: {
        nodes: [{
          commit: {
            oid: "sha-fail",
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                nodes: [
                  { databaseId: 1, name: "test", status: "COMPLETED", conclusion: "SUCCESS", title: "all good", detailsUrl: "https://example.com" },
                ],
              },
            },
          },
        }],
      },
    });
  }

  function makeRunningAutoFixPoller() {
    return makeRunningAutoFixHarness().poller;
  }

  function makeRunningAutoFixHarness() {
    const githubAuth = makeGitHubAuth({
      data: { repository: { pullRequests: { nodes: [makeFailingNode()] } } },
    });
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const registry = makeFakeRegistry();
    registry.setViewers("s1", 1);
    registry.setRunning("s1", false);
    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast: sseBroadcastAF,
      runnerRegistry: registry,
      isAutoFixEnabled: () => true,
      fetchAndFixCb: () => new Promise<never>(() => { /* hang */ }),
    });
    return { poller, githubAuth };
  }

  it("auto-fix loop flips state to running on a failing-CI poll", async () => {
    vi.useFakeTimers();
    const poller2 = makeRunningAutoFixPoller();
    poller2.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(poller2.getAutoFixState("s1")).toMatchObject({ status: "running" });
    poller2.destroy();
    vi.useRealTimers();
  });

  it("getAllStatuses surfaces the auto-fix state on the summary", async () => {
    vi.useFakeTimers();
    const poller2 = makeRunningAutoFixPoller();
    poller2.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    const statuses = poller2.getAllStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].autoFix).toMatchObject({ status: "running", maxAttempts: 3 });
    poller2.destroy();
    vi.useRealTimers();
  });

  it("publishes the 1-BASED in-flight attempt number, not the completed count", async () => {
    vi.useFakeTimers();
    const poller2 = makeRunningAutoFixPoller();
    poller2.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    expect(poller2.getAutoFixState("s1")).toMatchObject({ status: "running", attemptCount: 0 });
    expect(poller2.getAllStatuses()[0].autoFix).toMatchObject({ attemptCount: 1, maxAttempts: 3 });

    poller2.destroy();
    vi.useRealTimers();
  });

  it("does NOT attach auto-fix state over a green rollup", async () => {
    vi.useFakeTimers();
    const { poller: poller2, githubAuth } = makeRunningAutoFixHarness();
    poller2.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(poller2.getAllStatuses()[0].autoFix).toBeDefined();

    (githubAuth.graphqlQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [makePassingNode()] } } },
    });
    await vi.advanceTimersByTimeAsync(31_000);

    expect(poller2.getAllStatuses()[0].autoFix).toBeUndefined();
    expect(poller2.getAutoFixState("s1")).toBeUndefined();

    poller2.destroy();
    vi.useRealTimers();
  });
});

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

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId: "s1", prState: "merged", prNumber: 99 })],
    }));

    expect(onMergeDetected).toHaveBeenCalledWith("s1");

    poller.destroy();
  });

  it("fires the post-merge handler exactly once across repeated polls and a re-track", async () => {
    const withPr = { data: { repository: { pullRequests: { nodes: [makeGraphQLPrNode()] } } } };
    const mergedRest = {
      url: "https://github.com/owner/repo/pull/42",
      number: 42, base: "main", title: "Add feature", body: "x",
      state: "closed" as const, merged_at: "2026-05-19T12:00:00Z",
      additions: 100, deletions: 20,
    };
    const githubAuth = makeGitHubAuth(withPr, mergedRest);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/abc-feature", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [] } } },
    });
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(onMergeDetected).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(onMergeDetected).toHaveBeenCalledTimes(1);

    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);
    await poller.forceRefreshSession("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(onMergeDetected).toHaveBeenCalledTimes(1);

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
    (sessionManager.markClosed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const sseBroadcast = vi.fn();
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({ sessionId: "s1", prState: "closed", prNumber: 88 })],
    }));

    expect(onMergeDetected).not.toHaveBeenCalled();

    expect(sessionManager.markClosed).toHaveBeenCalledWith("s1");

    expect(sseBroadcast).toHaveBeenCalledWith("session_list", expect.objectContaining({
      sessions: expect.arrayContaining([expect.objectContaining({ id: "s1" })]),
    }));

    poller.destroy();
  });

  it("fires catch-up probe only once per session", async () => {
    const noPrs = { data: { repository: { pullRequests: { nodes: [] } } } };
    const githubAuth = makeGitHubAuth(noPrs, null);
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/no-pr-branch", remoteUrl: "https://github.com/owner/repo" },
    ]);
    const sseBroadcast = vi.fn();

    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);
    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalledTimes(1);

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

    expect(githubAuth.findPullRequestAnyState).not.toHaveBeenCalled();

    poller.destroy();
  });
});

describe("PrStatusPoller — turn-admission merge probe", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const mergedRest = {
    url: "https://github.com/owner/repo/pull/101",
    number: 101, base: "main", title: "Benchmark", body: "",
    state: "closed" as const, merged_at: "2026-08-22T19:32:02Z",
    additions: 4, deletions: 1, head_sha: "d7cfc48",
  };

  function makeHarness(restProbe: unknown) {
    const githubAuth = makeGitHubAuth(
      { data: { repository: { pullRequests: { nodes: [] } } } },
      restProbe,
    );
    const sessionManager = makeSessionManager([
      { id: "s1", branch: "shipit/benchmark", remoteUrl: "https://github.com/owner/repo" },
    ]);
    return { githubAuth, sessionManager, sseBroadcast: vi.fn() };
  }

  it("awaitMergeHandling resolves only once the merge bookkeeping has settled", async () => {
    const { githubAuth, sessionManager, sseBroadcast } = makeHarness(mergedRest);
    let release!: () => void;
    const onMergeDetected = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    await poller.forceVerifySessionPrState("s1", { armAbsentDebounce: false });
    expect(onMergeDetected).toHaveBeenCalledWith("s1");

    let settled = false;
    const waiting = (async () => {
      await poller.awaitMergeHandling("s1");
      settled = true;
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    release();
    await waiting;
    expect(settled).toBe(true);

    await poller.awaitMergeHandling("s1");
    poller.destroy();
  });

  it("drops a never-settling merge handler when the session is re-armed", async () => {
    const { githubAuth, sessionManager, sseBroadcast } = makeHarness(mergedRest);
    const onMergeDetected = vi.fn(() => new Promise<void>(() => {}));
    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    await poller.forceVerifySessionPrState("s1", { armAbsentDebounce: false });
    expect(onMergeDetected).toHaveBeenCalledWith("s1");

    poller.reArm("s1", 101);

    let settled = false;
    const waiting = (async () => {
      await poller.awaitMergeHandling("s1");
      settled = true;
    })();
    await vi.advanceTimersByTimeAsync(0);
    await waiting;
    expect(settled).toBe(true);
    poller.destroy();
  });

  it("leaves the missing-PR debounce un-armed when asked, so the next poll still verifies", async () => {
    const openRest = { ...mergedRest, state: "open" as const, merged_at: null };
    const { githubAuth, sessionManager, sseBroadcast } = makeHarness(openRest);
    const onMergeDetected = vi.fn().mockResolvedValue(undefined);
    const poller = new PrStatusPoller({ githubAuth, sessionManager, sseBroadcast, onMergeDetectedCb: onMergeDetected });
    poller.trackSession("s1", "https://github.com/owner/repo");
    await vi.advanceTimersByTimeAsync(0);

    await poller.forceVerifySessionPrState("s1", { armAbsentDebounce: false });
    const probesAfterRecheck = (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mock.calls.length;

    (githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mockResolvedValue(mergedRest);
    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect((githubAuth.findPullRequestAnyState as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(probesAfterRecheck);
    expect(onMergeDetected).toHaveBeenCalledWith("s1");
    poller.destroy();
  });
});

describe("PrStatusPoller — workflow-aware CI state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadWorkflows.mockReset();
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

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        checks: expect.objectContaining({ state: "success" }),
      })],
    }));

    poller.destroy();
  });

  it("skips grace immediately when no workflow's filters match the PR's changed files (docs-only PR case)", async () => {
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

    mockLoadWorkflows.mockResolvedValue([
      {
        unparseable: false,
        events: [{
          event: "pull_request",
          pathsInclude: [],
          pathsIgnore: ["docs/**", "**.md"],
          branchesInclude: [],
          branchesIgnore: [],
          tagsOnly: false,
        }],
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
        checks: expect.objectContaining({ state: "none" }),
      })],
    }));

    poller.destroy();
  });

  it("still forces pending when at least one workflow's filters match the PR's changed files", async () => {
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
        unparseable: false,
        events: [{
          event: "pull_request",
          pathsInclude: ["src/**"],
          pathsIgnore: [],
          branchesInclude: [],
          branchesIgnore: [],
          tagsOnly: false,
        }],
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

  it("skips grace when the repo's only workflow has no PR-relevant trigger (nikzlabs/shipit#1730)", async () => {
    const noCiNode = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-1", statusCheckRollup: null } }] },
      files: { nodes: [{ path: "src/index.ts" }] },
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
      workflowLoader.parseWorkflowContent(
        "on:\n  workflow_dispatch:\n  push:\n    branches:\n      - deploy\njobs: {}\n",
      ),
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
        checks: expect.objectContaining({ state: "none", total: 0 }),
      })],
    }));

    poller.destroy();
  });

  it("publishes a grace deadline alongside a forced-pending state", async () => {
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

    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

    const poller = new PrStatusPoller({
      githubAuth,
      sessionManager,
      sseBroadcast,
      getSharedRepoDir: () => "/repos/owner/repo",
    });
    poller.trackSession("s1", "https://github.com/owner/repo");

    await vi.advanceTimersByTimeAsync(0);

    const update = sseBroadcast.mock.calls
      .flatMap((call) => (call[1] as { updates?: PrStatusSummary[] }).updates ?? [])
      .find((u) => u.sessionId === "s1");
    expect(update?.checks.state).toBe("pending");
    expect(update?.checks.graceUntil).toBe(Date.now() + NO_CHECKS_GRACE_MS);

    poller.destroy();
  });

  it("retries workflow detection when first inspection finds no files (negative results not cached)", async () => {
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

    mockLoadWorkflows.mockResolvedValueOnce(null);

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

    sseBroadcast.mockClear();
    mockLoadWorkflows.mockResolvedValue([ALWAYS_APPLIES]);

    await vi.advanceTimersByTimeAsync(PR_STATUS_SLOW_INTERVAL_MS);

    expect(sseBroadcast).toHaveBeenCalledWith("pr_status", expect.objectContaining({
      updates: [expect.objectContaining({
        sessionId: "s1",
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

    poller.destroy();
  });

  it("treats 'none' as 'pending' when another PR in the same repo has observed checks (external CI)", async () => {
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

  it("keeps 'none' for repos that genuinely run no CI (no workflows, no observed checks anywhere)", async () => {
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
        checks: expect.objectContaining({ state: "pending" }),
      })],
    }));

    sseBroadcast.mockClear();

    await vi.advanceTimersByTimeAsync(31_000);

    const noneCall = sseBroadcast.mock.calls.find(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(noneCall, "expected a broadcast flipping state to none after grace").toBeDefined();

    poller.destroy();
  });

  it("resets grace window when head SHA changes (new push gives GitHub fresh time)", async () => {
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

    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(10_000);
    const sha2Node = makeGraphQLPrNode({
      commits: { nodes: [{ commit: { oid: "sha-2", statusCheckRollup: null } }] },
    });
    (githubAuth.graphqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { repository: { pullRequests: { nodes: [sha2Node] } } },
    });

    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

    sseBroadcast.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);

    const flippedToNone = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedToNone, "should not flip to none yet — SHA changed, grace restarted").toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    const flippedNow = sseBroadcast.mock.calls.some(([, payload]) => {
      const updates = (payload as { updates?: { checks?: { state?: string } }[] }).updates;
      return updates?.some((u) => u.checks?.state === "none");
    });
    expect(flippedNow).toBe(true);

    poller.destroy();
  });

  it("clears grace tracker when checks finally arrive — normal pending/success flow resumes", async () => {
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

    expect(githubAuth.graphqlQuery).not.toHaveBeenCalled();
    const rateLimitedCalls = sseBroadcast.mock.calls.filter(([event]) => event === "gh_rate_limited");
    expect(rateLimitedCalls).toHaveLength(1);
    expect(rateLimitedCalls[0][1]).toMatchObject({ resetAt: expect.any(Number) });

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

    limited = false;
    await vi.advanceTimersByTimeAsync(PR_STATUS_POLL_INTERVAL_MS);

    const clearedCalls = sseBroadcast.mock.calls.filter(([event]) => event === "gh_rate_limited_cleared");
    expect(clearedCalls).toHaveLength(1);
    const prStatusCalls = sseBroadcast.mock.calls.filter(([event]) => event === "pr_status");
    expect(prStatusCalls.length).toBeGreaterThan(0);
  });

  it("loadPersisted does NOT seed mergedSessions from a persisted merged snapshot", async () => {
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

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(githubAuth.findPullRequestAnyState).toHaveBeenCalled();
  });
});
