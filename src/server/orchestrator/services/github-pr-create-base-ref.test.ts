import { describe, it, expect, vi } from "vitest";
import { agentCreatePr } from "./github.js";
import type { GitManager, AutoCommitResult } from "../../shared/git.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { GitHubAuthManager } from "../github-auth.js";

const CLEAN_COMMIT: AutoCommitResult = {
  commitHash: "abc123",
  conflictedFiles: [],
  rebaseInProgress: false,
  secretFindings: [],
  unreadable: null,
};

const MERGED_PR = {
  number: 177,
  url: "https://github.com/o/r/pull/177",
  base: "main",
  title: "Earlier (merged) PR",
  body: "",
  state: "closed" as const,
  merged_at: "2026-09-01T17:32:00Z",
};

function fakeGit(overrides: Record<string, unknown> = {}) {
  // Object.assign preserves the mock types that spreading unknown overrides would widen.
  const git = {
    autoCommit: vi.fn(async () => CLEAN_COMMIT),
    getHeadHash: vi.fn(async () => "parent"),
    getCurrentBranch: vi.fn(async () => "shipit/feature"),
    getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    addRemote: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    forcePush: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    fetchBranch: vi.fn(async () => {}),
    diffStatVsBranch: vi.fn(async () => ({ insertions: 1, deletions: 0 })),
    mergedBaseProgress: vi.fn(async () => "progressed" as string),
    advancedBeyondMergedBase: vi.fn(async () => true),
    listRemoteBranches: vi.fn(async () => ["main"]),
    getDefaultBranch: vi.fn(async () => "main"),
    getRecentCommits: vi.fn(async () => []),
  };
  Object.assign(git, overrides);
  return git;
}

function authManager(openPr: unknown, anyStatePr: unknown) {
  const auth = {
    authenticated: true,
    findPullRequest: vi.fn(async () => openPr),
    findPullRequestAnyState: vi.fn(async () => anyStatePr),
    addLabelsToPullRequest: vi.fn(async () => ({ success: true })),
    createPullRequest: vi.fn(async (_args: { base: string }) => ({
      success: true, number: 200, url: "https://github.com/o/r/pull/200",
    })),
  };
  return auth;
}

const registry = { get: () => ({ sessionId: "s1", emitMessage: vi.fn() }) } as unknown as SessionRunnerRegistry;

const opts = { title: "T", sessionId: "s1", runnerRegistry: registry };

const call = (git: ReturnType<typeof fakeGit>, auth: ReturnType<typeof authManager>) =>
  agentCreatePr(git as unknown as GitManager, auth as unknown as GitHubAuthManager, opts);

describe("agentCreatePr — the base ref is freshened before the progress gate", () => {
  it("fetches origin, and does so BEFORE reading the gate", async () => {
    const git = fakeGit();
    await call(git, authManager(null, MERGED_PR));

    expect(git.fetchBranch).toHaveBeenCalledWith("origin", "main");
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.fetchBranch.mock.invocationCallOrder[0])
      .toBeLessThan(git.mergedBaseProgress.mock.invocationCallOrder[0]);
  });

  it("declines to decide when the fetch fails, instead of opening a duplicate PR", async () => {
    const git = fakeGit({
      fetchBranch: vi.fn(async () => { throw new Error("couldn't find remote ref"); }),
      fetch: vi.fn(async () => { throw new Error("network is unreachable"); }),
    });
    const auth = authManager(null, MERGED_PR);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await call(git, auth);

    expect(auth.createPullRequest).not.toHaveBeenCalled();
    expect(res.alreadyExisted).toBe(true);
    expect(res.number).toBe(177);
    expect(res.alreadyExistedReason).toBe("merged-not-progressed");
    expect(res.notProgressedBecause).toBe("fetch-failed");
    expect(git.mergedBaseProgress).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still opens the new PR when the fetch succeeds and the branch has progressed", async () => {
    const git = fakeGit();
    const auth = authManager(null, MERGED_PR);

    const res = await call(git, auth);

    expect(auth.createPullRequest).toHaveBeenCalledTimes(1);
    expect(res.alreadyExisted).toBe(false);
    expect(res.number).toBe(200);
  });

  it("does not fetch when an OPEN PR already hosts the branch", async () => {
    const git = fakeGit();
    const openPr = { number: 5, url: "https://github.com/o/r/pull/5", base: "main", title: "T", body: "" };

    await call(git, authManager(openPr, null));

    expect(git.fetchBranch).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it("does not fetch when the branch has no PR at all", async () => {
    const git = fakeGit();

    await call(git, authManager(null, null));

    expect(git.fetchBranch).not.toHaveBeenCalled();
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it("falls back to a broad fetch when the base branch is absent from the remote", async () => {
    const git = fakeGit({
      fetchBranch: vi.fn(async () => { throw new Error("couldn't find remote ref release/v1"); }),
      mergedBaseProgress: vi.fn(async () => "base-unknown" as string),
    });

    const res = await call(git, authManager(null, MERGED_PR));

    expect(git.fetch).toHaveBeenCalledWith("origin");
    expect(res.notProgressedBecause).not.toBe("fetch-failed");
  });

  it("opens a NEW PR when the prior base no longer exists, instead of blocking forever", async () => {
    const git = fakeGit({ mergedBaseProgress: vi.fn(async () => "base-unknown" as string) });
    const auth = authManager(null, { ...MERGED_PR, base: "release/v1" });

    const res = await call(git, auth);

    expect(res.alreadyExisted).toBe(false);
    expect(auth.createPullRequest).toHaveBeenCalledTimes(1);
    expect(auth.createPullRequest.mock.calls[0]?.[0].base).toBe("main");
    expect(git.forcePush).toHaveBeenCalledTimes(1);
    expect(git.push).not.toHaveBeenCalled();
  });
});
