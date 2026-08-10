import { describe, it, expect, vi } from "vitest";
import { flushPendingTurnCommit, agentCreatePr } from "./github.js";
import type { GitManager, AutoCommitResult } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { GitHubAuthManager } from "../github-auth.js";

// planning#200 — the debounced auto-push is only safe to drop once a *synchronous*
// push has actually replaced it. `flushPendingTurnCommit` must NOT cancel the
// timer (it can early-return before any push), and `agentCreatePr` must cancel
// it only AFTER its synchronous push lands — otherwise a short-circuiting flush
// (secretBlocked / no-commit) leaves the commit local with no retry.
//
// The cancel is session-keyed (`options.cancelAutoPush`) rather than resolved
// through the runner: the pending push lives in `services/auto-push-scheduler.ts`
// now, so a session whose runner was reclaimed still gets its debounce dropped —
// and, more to the point, still gets its push.

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
  ])("has no way to cancel the pending push (%s)", async (_label, result) => {
    // `flushPendingTurnCommit` is not given a cancel hook at all — the shape
    // that makes "it can early-return before any push" un-losable.
    const runner = fakeRunner();
    const flushed = await flushPendingTurnCommit(
      fakeGit({ autoCommit: vi.fn(async () => result) }),
      { sessionId: "s1", runnerRegistry: registryFor(runner) },
    );
    expect(flushed.commitHash).toBe(result.commitHash);
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

    // The commit was refused and no synchronous push happened, so the pending
    // debounced push must survive to carry the prior commit to the remote.
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
    expect(git.push).toHaveBeenCalledTimes(1);
    expect(cancelAutoPush).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("cancels the debounce even when the session has no live runner", async () => {
    // The runner is gone (reclaimed between the commit and this call), which
    // used to mean `pushRunner` was null and the debounce was left armed behind
    // a push that had already landed. The cancel is keyed on the session now.
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
