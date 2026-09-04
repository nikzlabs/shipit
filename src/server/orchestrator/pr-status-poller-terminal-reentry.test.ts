import { describe, it, expect, vi } from "vitest";
import { PrStatusPoller } from "./pr-status-poller.js";
import { makeSessionManager, makeGitHubAuth } from "./pr-poller-test-helpers.js";
import type { GitHubAuthManager } from "./github-auth.js";

/**
 * docs/287-agent-merge-per-repo req 11 — the terminal promotion has to be
 * CRASH-REENTRANT, and it was not.
 *
 * It persists the terminal pull-request snapshot first, derives `alreadyTerminal`
 * from that persisted state, and writes `mergedHeadSha`, `merged_at` and the
 * downstream merge handling later and only when `!alreadyTerminal`. A crash
 * between the two therefore restarts into `prevState === "merged"` and suppresses
 * those writes for ever: a session left with a merged card, no `merged_at`, no
 * reset eligibility, and nothing anywhere saying so.
 *
 * A durable `settling` claim is the evidence that those effects did not run, so
 * the by-number entry point re-enters instead of trusting the snapshot.
 */

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

    expect(facts).toMatchObject({ number: 7, merged_at: MERGED_PR.merged_at });
    expect(sessionManager.setMergedHeadSha).toHaveBeenCalledWith("s1", "sha-head");
    expect(onMergeDetectedCb).toHaveBeenCalledWith("s1");
  });

  it("re-enters after a crash that left the snapshot terminal and the rest unwritten", async () => {
    // The exact restart shape: `pr_status` already reads merged (the snapshot
    // persisted), while `merged_at` and `mergedHeadSha` never did. Ordinary
    // detection reads `prevState === "merged"` and stands down for ever.
    const sessionManager = makeSessionManager([{ id: "s1", branch: "shipit/feature" }]);
    const onMergeDetectedCb = vi.fn(async () => {});
    const poller = new PrStatusPoller({
      githubAuth: githubAuthFor(MERGED_PR),
      sessionManager,
      sseBroadcast: vi.fn(),
      onMergeDetectedCb,
    });

    // First promotion — this is the one the crash interrupted.
    await poller.promoteMergedPrByNumber({ sessionId: "s1", owner: "o", repo: "r", prNumber: 7 });
    onMergeDetectedCb.mockClear();
    (sessionManager.setMergedHeadSha as ReturnType<typeof vi.fn>).mockClear();

    // The restart: the poller re-reads the persisted terminal snapshot, and the
    // surviving `settling` claim asks for the promotion again.
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
    // Reconciliation can reach here for an attempt that never got to GitHub, so
    // the pull request may simply be open. Forcing it through the terminal path
    // would overwrite its status with the placeholder summary, add the session
    // to `mergedSessions`, and drop its remediation and auto-merge state — after
    // which polling skips it until it is re-tracked (cross-agent review finding).
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

    // The facts still come back, so the caller can see nothing merged…
    expect(facts).toMatchObject({ number: 7, merged_at: null });
    // …but nothing was promoted.
    expect(sessionManager.setPrStatus).not.toHaveBeenCalled();
    expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
    expect(onMergeDetectedCb).not.toHaveBeenCalled();
    expect(sseBroadcast).not.toHaveBeenCalled();
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
    // Closed is not merged, so the merge-only writes stay untouched.
    expect(sessionManager.setMergedHeadSha).not.toHaveBeenCalled();
  });

  it("addresses the pull request by number, never by branch", async () => {
    // A branch-addressed lookup takes the most recently updated pull request on
    // the branch, so a re-arm or an unarchive in the same repository makes it
    // settle a different pull request than the one that merged.
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
