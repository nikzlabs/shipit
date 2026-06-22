import { describe, it, expect, vi } from "vitest";
import { computeResetEligible, autoResetMergedBranchOnContinue, type PreTurnResetDeps } from "./pre-turn-reset.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

const MERGED_SHA = "a1f3c9d0000000000000000000000000000000aa";
const BASE_TIP = "7e02b480000000000000000000000000000000bb";

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Fix login redirect",
    createdAt: "2026-06-01T00:00:00.000Z",
    lastUsedAt: "2026-06-01T00:00:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/fix-login",
    mergedAt: "2026-06-02 12:00:00",
    mergedHeadSha: MERGED_SHA,
    ...over,
  };
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 482,
    prUrl: "https://github.com/o/r/pull/482",
    prTitle: "Fix login redirect",
    prBody: "",
    prState: "merged",
    baseBranch: "main",
    headBranch: "shipit/fix-login",
    insertions: 1,
    deletions: 0,
    checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

/** A fake GitManager exposing only the methods the gate + helper touch. */
function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    ...over,
  } as unknown as GitManager;
}

describe("computeResetEligible (safety-only gate)", () => {
  it("is true for a merged, untouched, clean branch on its own ref", async () => {
    expect(await computeResetEligible(makeSession(), makePrStatus(), makeGit())).toBe(true);
  });

  it("is false for a non-merged session", async () => {
    const s = makeSession();
    delete s.mergedAt;
    expect(await computeResetEligible(s, makePrStatus(), makeGit())).toBe(false);
  });

  it("is false when no mergedHeadSha was recorded (fail closed)", async () => {
    const s = makeSession();
    delete s.mergedHeadSha;
    expect(await computeResetEligible(s, makePrStatus(), makeGit())).toBe(false);
  });

  it("is false when the merged PR's base branch is unknown", async () => {
    expect(await computeResetEligible(makeSession(), null, makeGit())).toBe(false);
  });

  it("is false when the working tree is dirty", async () => {
    const git = makeGit({ isClean: vi.fn().mockResolvedValue(false) });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });

  it("is false on a detached HEAD", async () => {
    const git = makeGit({ currentBranchOrNull: vi.fn().mockResolvedValue(null) });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });

  it("is false when HEAD is on a different branch than session.branch", async () => {
    const git = makeGit({ currentBranchOrNull: vi.fn().mockResolvedValue("shipit/other") });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });

  it("is false during an in-progress rebase", async () => {
    const git = makeGit({ isRebaseInProgress: vi.fn().mockResolvedValue(true) });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });

  it("is false during an in-progress merge/cherry-pick/revert", async () => {
    const git = makeGit({ isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(true) });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });

  it("is false when HEAD has moved off the merged tip (new un-rebased work)", async () => {
    const git = makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef") });
    expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
  });
});

describe("autoResetMergedBranchOnContinue", () => {
  function makeDeps(over: Partial<PreTurnResetDeps> = {}): PreTurnResetDeps {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      getAutoResetMergedBranch: () => true,
      ...over,
    };
  }

  it("no-ops when the global setting is off (never touches git)", async () => {
    const git = makeGit();
    const out = await autoResetMergedBranchOnContinue(
      makeDeps({ getAutoResetMergedBranch: () => false, createGitManager: () => git }),
      "s1",
      "/ws",
    );
    expect(out.moved).toBe(false);
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("fetches, re-gates, resets, and returns move info + agent prefix when eligible", async () => {
    const git = makeGit();
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(git.fetch).toHaveBeenCalledWith("origin");
    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    expect(out).toMatchObject({
      moved: true,
      base: "main",
      prNumber: 482,
      prUrl: "https://github.com/o/r/pull/482",
      fromSha: MERGED_SHA,
      toSha: BASE_TIP,
    });
    expect(out.agentPrefix).toContain("#482");
    expect(out.agentPrefix).toContain("origin/main");
    expect(out.agentPrefix).toContain("do not re-apply");
  });

  it("does not reset when the gate fails (dirty tree)", async () => {
    const git = makeGit({ isClean: vi.fn().mockResolvedValue(false) });
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(out.moved).toBe(false);
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("re-validates AFTER the fetch and bails if the branch moved (TOCTOU)", async () => {
    // Eligible before the fetch, but the fetch 'yields' and the branch advances
    // off the merged tip — the second gate must catch it and skip the reset.
    const getHeadHash = vi
      .fn()
      .mockResolvedValueOnce(MERGED_SHA) // pre-fetch gate
      .mockResolvedValue("deadbeef0000000000000000000000000000beef"); // post-fetch gate
    const git = makeGit({ getHeadHash });
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(git.fetch).toHaveBeenCalledOnce();
    expect(out.moved).toBe(false);
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("is fail-safe: a git throw returns moved:false rather than propagating", async () => {
    const git = makeGit({ resetHardToRemoteBase: vi.fn().mockRejectedValue(new Error("origin/main missing")) });
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(out.moved).toBe(false);
  });
});
