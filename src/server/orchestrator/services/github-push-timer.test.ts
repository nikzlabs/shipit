import { describe, it, expect, vi } from "vitest";
import { flushPendingTurnCommit, agentCreatePr } from "./github.js";
import type { GitManager, AutoCommitResult } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { GitHubAuthManager } from "../github-auth.js";

function fakeGit(overrides: Partial<Record<keyof GitManager, unknown>>): GitManager {
  return {
    getHeadHash: vi.fn(async () => "parent"),
    getCurrentBranch: vi.fn(async () => "feature"),
    getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    addRemote: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    forcePush: vi.fn(async () => {}),
    diffStatVsBranch: vi.fn(async () => ({ insertions: 1, deletions: 0 })),
    advancedBeyondMergedBase: vi.fn(async () => false),
    mergedBaseProgress: vi.fn(async () => "base-not-contained" as const),
    ...overrides,
  } as unknown as GitManager;
}

function fakeRunner() {
  return {
    sessionId: "s1",
    turnSummary: "do things",
    emitMessage: vi.fn(),
    pendingCommitLink: null as unknown,
  };
}

function registryFor(runner: ReturnType<typeof fakeRunner>): SessionRunnerRegistry {
  return { get: () => runner } as unknown as SessionRunnerRegistry;
}

const SECRET_COMMIT: AutoCommitResult = {
  commitHash: null,
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [
    { rule: "github-pat", description: "GitHub PAT", file: "x.ts", redacted: "ghp_…[redacted]" },
  ],
  unreadable: null,
};
const CLEAN_COMMIT: AutoCommitResult = {
  commitHash: "abc123",
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [], unreadable: null,
};
const NO_COMMIT: AutoCommitResult = {
  commitHash: null,
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [], unreadable: null,
};

describe("flushPendingTurnCommit — does not touch the push debounce", () => {
  it.each([
    ["secret refusal", SECRET_COMMIT],
    ["nothing to commit", NO_COMMIT],
    ["a normal commit", CLEAN_COMMIT],
  ])("has no way to cancel the pending push (%s)", async (_label, result) => {
    const runner = fakeRunner();
    const flushed = await flushPendingTurnCommit(
      fakeGit({ autoCommit: vi.fn(async () => result) }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(flushed.kind).toBe(
      result.secretFindings.length > 0
        ? "blocked-secret"
        : result.commitHash ? "committed" : "nothing-to-commit",
    );
  });
});

describe("agentCreatePr — debounce cancellation is coupled to the synchronous push", () => {
  function authManager(pr: unknown): GitHubAuthManager {
    return {
      authenticated: true,
      findPullRequest: vi.fn(async () => pr),
      findPullRequestAnyState: vi.fn(async () => null),
      addLabelsToPullRequest: vi.fn(async () => ({ success: true })),
    } as unknown as GitHubAuthManager;
  }

  it("leaves the debounce armed when the flush short-circuits on a secret", async () => {
    const runner = fakeRunner();
    const cancelAutoPush = vi.fn();
    const git = fakeGit({ autoCommit: vi.fn(async () => SECRET_COMMIT) });

    await expect(
      agentCreatePr(git, authManager(null), {
        title: "t",
        sessionId: "s1",
        runnerRegistry: registryFor(runner),
        cancelAutoPush,
      }),
    ).rejects.toThrow(/secret/i);

    expect(cancelAutoPush).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("cancels the debounce after pushing to an existing open PR", async () => {
    const runner = fakeRunner();
    const cancelAutoPush = vi.fn();
    const git = fakeGit({ autoCommit: vi.fn(async () => CLEAN_COMMIT) });
    const auth = authManager({ number: 7, url: "https://gh/pr/7", base: "main", title: "T", body: "" });

    const res = await agentCreatePr(git, auth, {
      sessionId: "s1",
      runnerRegistry: registryFor(runner),
      cancelAutoPush,
    });

    expect(res.alreadyExisted).toBe(true);
    expect(res.alreadyExistedReason).toBe("open");
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(cancelAutoPush).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("cancels the debounce even when the session has no live runner", async () => {
    const cancelAutoPush = vi.fn();
    const git = fakeGit({ autoCommit: vi.fn(async () => CLEAN_COMMIT) });
    const auth = authManager({ number: 7, url: "https://gh/pr/7", base: "main", title: "T", body: "" });

    await agentCreatePr(git, auth, {
      sessionId: "s1",
      runnerRegistry: { get: () => undefined } as unknown as SessionRunnerRegistry,
      cancelAutoPush,
    });

    expect(cancelAutoPush).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("does NOT cancel the debounce if the synchronous push fails", async () => {
    const runner = fakeRunner();
    const cancelAutoPush = vi.fn();
    const git = fakeGit({
      autoCommit: vi.fn(async () => CLEAN_COMMIT),
      push: vi.fn(async () => { throw new Error("boom"); }),
    });
    const auth = authManager({ number: 7, url: "https://gh/pr/7", base: "main", title: "T", body: "" });

    await expect(
      agentCreatePr(git, auth, {
        sessionId: "s1",
        runnerRegistry: registryFor(runner),
        cancelAutoPush,
      }),
    ).rejects.toThrow(/Push failed/);
    expect(cancelAutoPush).not.toHaveBeenCalled();
  });
});
