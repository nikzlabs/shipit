import { describe, it, expect, vi } from "vitest";
import { PrStatusPoller } from "./pr-status-poller.js";
import { makeSessionManager, makeGitHubAuth } from "./pr-poller-test-helpers.js";
import type { GitHubAuthManager } from "./github-auth.js";

const MERGED_PR = {
  url: "https://github.com/o/r/pull/7",
  number: 7,
  base: "main",
  title: "A pull request",
  body: "",
  state: "closed" as "open" | "closed",
  merged_at: "2026-09-04T12:00:00Z",
  merge_commit_sha: "merge-sha",
  head_sha: "sha-head",
  head_ref: "shipit/feature",
  additions: 1,
  deletions: 0,
};

function githubAuthFor(pr: (Omit<typeof MERGED_PR, "merged_at"> & { merged_at: string | null }) | null): GitHubAuthManager {
  const auth = makeGitHubAuth() as GitHubAuthManager & {
    findPullRequestByNumber: ReturnType<typeof vi.fn>;
  };
  auth.findPullRequestByNumber = vi.fn().mockResolvedValue(pr);
  return auth;
}

describe("promoteMergedPrByNumber", () => {
  it("lands merged_at, the anchor and the merge handling on a first promotion", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(MERGED_PR),
      sessionManager,
      sseBroadcast: vi.fn(),
      onMergeDetectedCb,
    });

    const facts = await poller.promoteMergedPrByNumber({
      sessionId: "s1", owner: "o", repo: "r", prNumber: 7,
    });

    expect(facts).toMatchObject({ promoted: true, pr: { number: 7, merged_at: MERGED_PR.merged_at } });
    expect(sessionManager.setMergedHeadSha).toHaveBeenCalledWith("s1", "sha-head");
    expect(onMergeDetectedCb).toHaveBeenCalledWith("s1");
  });

  it("re-enters after a crash that left the snapshot terminal and the rest unwritten", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(MERGED_PR),
      sessionManager,
      sseBroadcast: vi.fn(),
      onMergeDetectedCb,
    });

    await poller.promoteMergedPrByNumber({ sessionId: "s1", owner: "o", repo: "r", prNumber: 7 });
    onMergeDetectedCb.mockClear();
    (sessionManager.setMergedHeadSha as ReturnType<typeof vi.fn>).mockClear();

    await poller.promoteMergedPrByNumber({ sessionId: "s1", owner: "o", repo: "r", prNumber: 7 });

    expect(sessionManager.setMergedHeadSha).toHaveBeenCalledWith("s1", "sha-head");
    expect(onMergeDetectedCb).toHaveBeenCalledWith("s1");
  });

  it("leaves the claim's work undone when GitHub does not answer", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(null),
      sessionManager,
      sseBroadcast: vi.fn(),
      onMergeDetectedCb,
    });

    const facts = await poller.promoteMergedPrByNumber({
      sessionId: "s1", owner: "o", repo: "r", prNumber: 7,
    });

    expect(facts).toBeNull();
    expect(onMergeDetectedCb).not.toHaveBeenCalled();
  });

  it("does NOT terminal-promote a pull request that is still open", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const sseBroadcast = vi.fn();
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor({ ...MERGED_PR, state: "open", merged_at: null }),
      sessionManager,
      sseBroadcast,
      onMergeDetectedCb,
    });

    const facts = await poller.promoteMergedPrByNumber({
      sessionId: "s1", owner: "o", repo: "r", prNumber: 7,
    });

    expect(facts).toMatchObject({ promoted: false, pr: { number: 7, merged_at: null } });
    expect(sessionManager.setPrStatus).not.toHaveBeenCalled();
    expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
    expect(onMergeDetectedCb).not.toHaveBeenCalled();
    expect(sseBroadcast).not.toHaveBeenCalled();
  });

  it("asks the caller's guard AFTER the read and writes nothing when it says no", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const sseBroadcast = vi.fn();
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(MERGED_PR),
      sessionManager,
      sseBroadcast,
      onMergeDetectedCb,
    });

    const guard = vi.fn(() => false);
    const res = await poller.promoteMergedPrByNumber({
      sessionId: "s1", owner: "o", repo: "r", prNumber: 7, guard,
    });

    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ number: 7, head_sha: "sha-head" }));
    expect(res).toMatchObject({ promoted: false, pr: { number: 7 } });
    expect(sessionManager.setPrStatus).not.toHaveBeenCalled();
    expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
    expect(onMergeDetectedCb).not.toHaveBeenCalled();
    expect(sseBroadcast).not.toHaveBeenCalled();
  });

  it("promotes when the guard agrees", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(MERGED_PR),
      sessionManager,
      sseBroadcast: vi.fn(),
      onMergeDetectedCb: vi.fn(async () => {}),
    });

    const res = await poller.promoteMergedPrByNumber({
      sessionId: "s1", owner: "o", repo: "r", prNumber: 7, guard: () => true,
    });

    expect(res).toMatchObject({ promoted: true });
    expect(sessionManager.setMergedHeadSha).toHaveBeenCalledWith("s1", "sha-head");
  });

  it("promotes a closed-without-merge pull request, which is terminal too", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor({ ...MERGED_PR, state: "closed", merged_at: null }),
      sessionManager,
      sseBroadcast: vi.fn(),
    });

    await poller.promoteMergedPrByNumber({ sessionId: "s1", owner: "o", repo: "r", prNumber: 7 });

    expect(sessionManager.setPrStatus).toHaveBeenCalled();
    expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
  });

  it("addresses the pull request by number, never by branch", async () => {
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const auth = githubAuthFor(MERGED_PR);
    const poller = new PrStatusPoller({
      githubAuth: auth, sessionManager, sseBroadcast: vi.fn(),
    });

    await poller.promoteMergedPrByNumber({ sessionId: "s1", owner: "o", repo: "r", prNumber: 7 });

    expect((auth as unknown as { findPullRequestByNumber: ReturnType<typeof vi.fn> })
      .findPullRequestByNumber).toHaveBeenCalledWith("o", "r", 7);
    expect(auth.findPullRequestAnyState).not.toHaveBeenCalled();
  });
});
