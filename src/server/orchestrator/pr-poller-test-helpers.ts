/**
 * Shared fakes/factories for the PR-poller test suites.
 *
 * Extracted from `pr-status-poller.test.ts` (docs/201 Phase P9) so the poller,
 * supervisor (cadence), and global-gate (viewer-gating) test files can each
 * drive the same minimal stubs without duplicating them.
 */

import { vi } from "vitest";
import type { ParsedWorkflow } from "./workflow-loader.js";
import type { SessionManager } from "./sessions.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "./session-runner.js";

/**
 * Minimal SessionRunnerRegistry fake for tests that need to drive the
 * viewer-gated supervisor. Lets a test attach/detach viewers and toggle a
 * session's `running` flag without spinning up real runners.
 */
export function makeFakeRegistry(): SessionRunnerRegistry & {
  setViewers(sessionId: string, count: number): void;
  setRunning(sessionId: string, running: boolean): void;
} {
  const runners = new Map<string, { viewerCount: number; running: boolean }>();
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
      return { viewerCount: r.viewerCount, running: r.running } as unknown as SessionRunnerInterface;
    },
    setViewers(sessionId: string, count: number) { ensure(sessionId).viewerCount = count; },
    setRunning(sessionId: string, running: boolean) { ensure(sessionId).running = running; },
  } as unknown as SessionRunnerRegistry & {
    setViewers(sessionId: string, count: number): void;
    setRunning(sessionId: string, running: boolean): void;
  };
}

/** Convenience: a parsed-workflow stub representing "any workflow, no filter." */
export const ALWAYS_APPLIES: ParsedWorkflow = { alwaysApplies: true, events: [] };

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

/** Conversation selections as GitHub returns them (docs/133 Phase 4). */
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

export function makeSessionManager(sessions: { id: string; branch?: string; remoteUrl?: string; workspaceDir?: string }[]): SessionManager {
  return {
    list: () => sessions.map((s) => ({
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
    getAllPrStatuses: vi.fn().mockReturnValue([]),
    // Mutate the backing array so a later get() reflects the corrected URL,
    // mirroring the real manager's persist-then-read behavior.
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
    // Poller reads this on every tick; default to "not limited" so existing
    // tests don't need to know about the rate-limit gate.
    getRateLimitState: vi.fn().mockReturnValue({ limited: false, resetAt: null, remaining: null }),
  } as unknown as GitHubAuthManager;
}
