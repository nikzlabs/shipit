import { describe, it, expect, vi } from "vitest";
import { flushPendingTurnCommit, agentCreatePr } from "./github.js";
import type { GitManager, AutoCommitResult } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { GitHubAuthManager } from "../github-auth.js";

// SHI-198 — the debounced auto-push is only safe to drop once a *synchronous*
// push has actually replaced it. `flushPendingTurnCommit` must NOT cancel the
// timer (it can early-return before any push), and `agentCreatePr` must cancel
// it only AFTER its synchronous push lands — otherwise a short-circuiting flush
// (secretBlocked / no-commit) leaves the commit local with no retry.

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
    ...overrides,
  } as unknown as GitManager;
}

function fakeRunner() {
  return {
    sessionId: "s1",
    turnSummary: "do things",
    clearPushTimer: vi.fn(),
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
};
const CLEAN_COMMIT: AutoCommitResult = {
  commitHash: "abc123",
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [],
};
const NO_COMMIT: AutoCommitResult = {
  commitHash: null,
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [],
};

describe("flushPendingTurnCommit — does not touch the push debounce", () => {
  it.each([
    ["secret refusal", SECRET_COMMIT],
    ["nothing to commit", NO_COMMIT],
    ["a normal commit", CLEAN_COMMIT],
  ])("never cancels the pending push (%s)", async (_label, result) => {
    const runner = fakeRunner();
    await flushPendingTurnCommit(fakeGit({ autoCommit: vi.fn(async () => result) }), {
      sessionId: "s1",
      runnerRegistry: registryFor(runner),
    });
    expect(runner.clearPushTimer).not.toHaveBeenCalled();
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
    const git = fakeGit({ autoCommit: vi.fn(async () => SECRET_COMMIT) });

    await expect(
      agentCreatePr(git, authManager(null), {
        title: "t",
        sessionId: "s1",
        runnerRegistry: registryFor(runner),
      }),
    ).rejects.toThrow(/secret/i);

    // The commit was refused and no synchronous push happened, so the pending
    // debounced push must survive to carry the prior commit to the remote.
    expect(runner.clearPushTimer).not.toHaveBeenCalled();
    expect(git.push).not.toHaveBeenCalled();
  });

  it("cancels the debounce after pushing to an existing open PR", async () => {
    const runner = fakeRunner();
    const git = fakeGit({ autoCommit: vi.fn(async () => CLEAN_COMMIT) });
    const auth = authManager({ number: 7, url: "https://gh/pr/7", base: "main", title: "T", body: "" });

    const res = await agentCreatePr(git, auth, {
      sessionId: "s1",
      runnerRegistry: registryFor(runner),
    });

    expect(res.alreadyExisted).toBe(true);
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(runner.clearPushTimer).toHaveBeenCalledTimes(1);
  });

  it("does NOT cancel the debounce if the synchronous push fails", async () => {
    const runner = fakeRunner();
    const git = fakeGit({
      autoCommit: vi.fn(async () => CLEAN_COMMIT),
      push: vi.fn(async () => { throw new Error("boom"); }),
    });
    const auth = authManager({ number: 7, url: "https://gh/pr/7", base: "main", title: "T", body: "" });

    await expect(
      agentCreatePr(git, auth, { sessionId: "s1", runnerRegistry: registryFor(runner) }),
    ).rejects.toThrow(/Push failed/);
    expect(runner.clearPushTimer).not.toHaveBeenCalled();
  });
});
