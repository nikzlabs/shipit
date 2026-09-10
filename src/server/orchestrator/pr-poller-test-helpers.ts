import { vi } from "vitest";
import type { ParsedWorkflow } from "./workflow-loader.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";

// setBusy models work that continues after the agent's running flag clears.
export function makeFakeRegistry(): SessionRunnerRegistry & {
  setViewers(sessionId: string, count: number): void;
  setRunning(sessionId: string, running: boolean): void;
  setBusy(sessionId: string, busy: boolean | undefined): void;
} {
  const runners = new Map<string, { viewerCount: number; running: boolean; busy?: boolean }>();
  const ensure = (id: string) => {
    let r = runners.get(id);
    if (!r) { r = { viewerCount: 0, running: false }; runners.set(id, r); }
    return r;
  };
  return {
    ids: () => [...runners.keys()],
    get: (id: string) => {
      const r = runners.get(id);
      if (!r) return undefined;
      return {
        viewerCount: r.viewerCount,
        running: r.running,
        agentBusy: r.busy ?? r.running,
      } as unknown as SessionRunnerInterface;
    },
    setViewers(sessionId: string, count: number) { ensure(sessionId).viewerCount = count; },
    setRunning(sessionId: string, running: boolean) { ensure(sessionId).running = running; },
    setBusy(sessionId: string, busy: boolean | undefined) { ensure(sessionId).busy = busy; },
  } as unknown as SessionRunnerRegistry & {
    setViewers(sessionId: string, count: number): void;
    setRunning(sessionId: string, running: boolean): void;
    setBusy(sessionId: string, busy: boolean | undefined): void;
  };
}

export const ALWAYS_APPLIES: ParsedWorkflow = {
  unparseable: false,
  events: [
    {
      event: "pull_request",
      pathsInclude: [],
      pathsIgnore: [],
      branchesInclude: [],
      branchesIgnore: [],
      tagsOnly: false,
    },
  ],
};

export function makeGraphQLPrNode(overrides: Record<string, unknown> = {}) {
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
    baseRefOid: "base123",
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

export const CONVERSATION_OVERRIDES = {
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

export function makeSessionManager(
  sessions: { id: string; branch?: string; remoteUrl?: string; workspaceDir?: string; archived?: boolean }[],
  opts: { pendingMergeWatches?: string[] } = {},
): SessionManager {
  return {
    list: () => sessions.filter((s) => !s.archived).map((s) => ({
      id: s.id,
      title: "Test",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      branch: s.branch,
      remoteUrl: s.remoteUrl,
      workspaceDir: s.workspaceDir,
    })),
    get: (id: string) => sessions.find((s) => s.id === id) as never,
    setPrStatus: vi.fn(),
    markClosed: vi.fn(),
    setMergedHeadSha: vi.fn(),
    getAllPrStatuses: vi.fn().mockReturnValue([]),
    listPendingMergeWatches: vi.fn(() =>
      (opts.pendingMergeWatches ?? []).map((childSessionId) => ({
        childSessionId,
        watch: { parentSessionId: "parent", state: "armed", registeredAt: new Date().toISOString() },
      })),
    ),
    setRemoteUrl: vi.fn((id: string, remoteUrl: string | undefined) => {
      const s = sessions.find((x) => x.id === id);
      if (s) s.remoteUrl = remoteUrl;
    }),
  } as unknown as SessionManager;
}

export function makeGitHubAuth(graphqlResult: unknown = null, restProbeResult: unknown = null): GitHubAuthManager {
  return {
    authenticated: true,
    graphqlQuery: vi.fn().mockResolvedValue(graphqlResult),
    findPullRequestAnyState: vi.fn().mockResolvedValue(restProbeResult),
    getRateLimitState: vi.fn().mockReturnValue({ limited: false, resetAt: null, remaining: null }),
    mergePullRequest: vi.fn().mockResolvedValue({ success: true, message: "merged" }),
  } as unknown as GitHubAuthManager;
}
