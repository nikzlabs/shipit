/**
 * `agentCreatePr` must freshen `origin/<base>` BEFORE it asks whether a branch
 * with a dead pull request has progressed past it.
 *
 * The gate reads `origin/<base>` from the session's own clone, and that ref only
 * moves when this clone fetches — nothing on the merge path does. Against a
 * stale ref the gate reports `progressed` for a branch carrying nothing but
 * already-merged work (demonstrated on a real repository in
 * `shared/git-rearm-detect.test.ts`), and this path would then open a duplicate
 * pull request whose whole diff already shipped.
 *
 * So these pin three things: that the fetch happens, that it happens FIRST, and
 * that a failed fetch makes the service decline to decide rather than decide off
 * a ref it knows may be stale.
 */

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
  // `Object.assign` rather than a spread: a spread of `unknown` values would
  // widen every default's type and cost the `.mock` handles these tests read.
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

/** `openPr` is what `findPullRequest` returns; `anyStatePr` the fallback lookup. */
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

/** The two fakes are structural stand-ins; only this boundary needs the cast. */
const call = (git: ReturnType<typeof fakeGit>, auth: ReturnType<typeof authManager>) =>
  agentCreatePr(git as unknown as GitManager, auth as unknown as GitHubAuthManager, opts);

describe("agentCreatePr — the base ref is freshened before the progress gate", () => {
  it("fetches origin, and does so BEFORE reading the gate", async () => {
    const git = fakeGit();
    await call(git, authManager(null, MERGED_PR));

    // The ONE ref, not the remote: a bare `git fetch origin` can succeed without
    // moving `origin/<base>` on a clone with a narrowed refspec.
    expect(git.fetchBranch).toHaveBeenCalledWith("origin", "main");
    expect(git.fetch).not.toHaveBeenCalled();
    // Order is the whole point: a fetch after the gate reads is no fetch at all.
    expect(git.fetchBranch.mock.invocationCallOrder[0])
      .toBeLessThan(git.mergedBaseProgress.mock.invocationCallOrder[0]);
  });

  it("declines to decide when the fetch fails, instead of opening a duplicate PR", async () => {
    // The stale-ref shape: the gate WOULD say "progressed" (it is stubbed to),
    // so anything other than a hard refusal here creates a second PR for work
    // that already shipped under #177.
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
    // The gate is never consulted — there is nothing trustworthy to consult it on.
    expect(git.mergedBaseProgress).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still opens the new PR when the fetch succeeds and the branch has progressed", async () => {
    // The fetch must not become a new way for the legitimate path to fail.
    const git = fakeGit();
    const auth = authManager(null, MERGED_PR);

    const res = await call(git, auth);

    expect(auth.createPullRequest).toHaveBeenCalledTimes(1);
    expect(res.alreadyExisted).toBe(false);
    expect(res.number).toBe(200);
  });

  it("does not fetch when an OPEN PR already hosts the branch", async () => {
    // The open-PR short-circuit never reads the gate, so the fetch would be a
    // network round-trip bought for nothing on the most common path.
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
    // `fetchBranch` throws for a deleted base. That must not read as "the remote
    // is unreachable" — the broad fetch proves it answered, and the gate then
    // gets to say `base-unknown` rather than the service refusing outright.
    const git = fakeGit({
      fetchBranch: vi.fn(async () => { throw new Error("couldn't find remote ref release/v1"); }),
      mergedBaseProgress: vi.fn(async () => "base-unknown" as string),
    });

    const res = await call(git, authManager(null, MERGED_PR));

    expect(git.fetch).toHaveBeenCalledWith("origin");
    expect(res.notProgressedBecause).not.toBe("fetch-failed");
  });

  it("opens a NEW PR when the prior base no longer exists, instead of blocking forever", async () => {
    // A deleted release branch used to be a permanent dead end: the gate can
    // never be satisfied against a base that is gone, so the branch could never
    // open another PR however much real work it carried. Nothing can be
    // duplicated into a base that does not exist, so this falls through.
    const git = fakeGit({ mergedBaseProgress: vi.fn(async () => "base-unknown" as string) });
    const auth = authManager(null, { ...MERGED_PR, base: "release/v1" });

    const res = await call(git, auth);

    expect(res.alreadyExisted).toBe(false);
    expect(auth.createPullRequest).toHaveBeenCalledTimes(1);
    // NOT the dead branch: the new PR targets the detected default instead.
    expect(auth.createPullRequest.mock.calls[0]?.[0].base).toBe("main");
    // The surviving remote branch has diverged either way, so the push forces.
    expect(git.forcePush).toHaveBeenCalledTimes(1);
    expect(git.push).not.toHaveBeenCalled();
  });
});
