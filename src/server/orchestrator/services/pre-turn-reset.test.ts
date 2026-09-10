import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { computeResetEligible, computeResetBlocker, autoResetMergedBranchOnContinue, isResetEligible, emitResetEligible, announceResetStateOnMerge, clearResetSkipEpisode, resetBranchToBaseExplicit, RESET_REFUSAL_GUIDANCE, type PreTurnResetDeps, type MergeNoticeRunner } from "./pre-turn-reset.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";

vi.mock("../session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));
vi.mock("../git-lfs.js", () => ({
  restoreLfsAfterTreeRewrite: vi.fn(() =>
    Promise.resolve({ status: "not-an-lfs-repo" as const, usesLfs: false }),
  ),
}));
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { PrStatusPoller } from "../pr-status-poller.js";
import { makeGitHubAuth } from "../pr-poller-test-helpers.js";
import { detectAndReArmResetSession } from "./pr-rearm.js";
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

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    uncommittedPaths: vi.fn().mockResolvedValue([]),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    isAncestor: vi.fn().mockResolvedValue(false),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    forcePush: vi.fn().mockResolvedValue("Force pushed to origin/shipit/fix-login"),
    ...over,
  } as unknown as GitManager;
}

beforeEach(() => { clearResetSkipEpisode("s1"); });

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

  describe("HEAD contained in origin/<base> (provable safety)", () => {
    it("is true when HEAD is a strict ancestor of the base tip, even off the anchor", async () => {
      const git = makeGit({
        getHeadHash: vi.fn().mockResolvedValue("484318fd4d36582291b86e56a88528e93faf7827"),
        isAncestor: vi.fn().mockResolvedValue(true),
      });
      expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(true);
      expect(git.isAncestor).toHaveBeenCalledWith(
        "484318fd4d36582291b86e56a88528e93faf7827",
        "origin/main",
      );
    });

    it("is true with NO anchor recorded at all — the proof needs nothing stored", async () => {
      const s = makeSession();
      delete s.mergedHeadSha;
      const git = makeGit({
        getHeadHash: vi.fn().mockResolvedValue("484318fd4d36582291b86e56a88528e93faf7827"),
        isAncestor: vi.fn().mockResolvedValue(true),
      });
      expect(await computeResetEligible(s, makePrStatus(), git)).toBe(true);
    });

    it("does NOT fire for a commit made without rebasing (the data-loss shortcut)", async () => {
      const git = makeGit({
        getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef"),
        isAncestor: vi.fn().mockResolvedValue(false),
      });
      expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
    });

    it("never overrides the clean-tree check", async () => {
      const git = makeGit({
        isClean: vi.fn().mockResolvedValue(false),
        isAncestor: vi.fn().mockResolvedValue(true),
      });
      expect(await computeResetEligible(makeSession(), makePrStatus(), git)).toBe(false);
    });
  });

  describe("survives a docs/202 re-arm", () => {
    function reArmed(over: Partial<SessionInfo> = {}): SessionInfo {
      const s = makeSession(over);
      delete s.mergedAt;
      delete s.mergedHeadSha;
      s.previousMergedPr = {
        number: 482,
        url: "https://github.com/o/r/pull/482",
        title: "Fix login redirect",
        baseBranch: "main",
        mergedHeadSha: MERGED_SHA,
      };
      return s;
    }

    it("is true for a re-armed session still sitting on the merged tip", async () => {
      expect(await computeResetEligible(reArmed(), null, makeGit())).toBe(true);
    });

    it("is false — as head-moved, not not-merged — when the re-armed branch gained work", async () => {
      const git = makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef") });
      expect(await computeResetBlocker(reArmed(), null, git)).toMatchObject({ clause: "head-moved" });
    });

    it("is false — as no-merged-head-sha — for a breadcrumb written before the anchor was carried", async () => {
      const s = reArmed();
      delete s.previousMergedPr!.mergedHeadSha;
      const git = makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef") });
      expect(await computeResetBlocker(s, null, git)).toMatchObject({ clause: "no-merged-head-sha" });
    });

    it("still reports not-merged for a session that never shipped anything", async () => {
      const s = makeSession();
      delete s.mergedAt;
      expect(await computeResetBlocker(s, null, makeGit())).toMatchObject({ clause: "not-merged" });
    });
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
    expect(git.forcePush).toHaveBeenCalledWith("origin");
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

  it("nikzlabs/shipit#2349: restores LFS content the reset rewrote as pointer text", async () => {
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    const git = makeGit();
    await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      "/ws",
      expect.stringContaining("main"),
      expect.any(Function),
    );
  });

  it("nikzlabs/shipit#2349: does not restore when the gate refused — nothing was rewritten", async () => {
    vi.mocked(restoreLfsAfterTreeRewrite).mockClear();
    const git = makeGit({ isClean: vi.fn().mockResolvedValue(false) });
    await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(restoreLfsAfterTreeRewrite).not.toHaveBeenCalled();
  });

  it("does not reset when the gate fails (dirty tree)", async () => {
    const git = makeGit({ isClean: vi.fn().mockResolvedValue(false) });
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(out.moved).toBe(false);
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("re-validates AFTER the fetch and bails if the branch moved (TOCTOU)", async () => {
    const getHeadHash = vi
      .fn()
      .mockResolvedValueOnce(MERGED_SHA)
      .mockResolvedValue("deadbeef0000000000000000000000000000beef");
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

  it("still reports moved:true when the remote-heal force-push fails (best-effort)", async () => {
    const git = makeGit({ forcePush: vi.fn().mockRejectedValue(new Error("(stale info)")) });
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    expect(git.forcePush).toHaveBeenCalledWith("origin");
    expect(out.moved).toBe(true);
  });

  it("skips when the user unticked the control for this send (intent=false)", async () => {
    const git = makeGit();
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws", false);
    expect(out.moved).toBe(false);
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("proceeds when intent is true (control left checked)", async () => {
    const git = makeGit();
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws", true);
    expect(out.moved).toBe(true);
    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
  });

  it("proceeds when intent is undefined (no control on this send path → follow setting)", async () => {
    const git = makeGit();
    const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws", undefined);
    expect(out.moved).toBe(true);
  });

  describe("workspace ownership handback", () => {
    it("hands back after a successful reset", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => makeGit() }), "s1", "/ws");
      expect(out.moved).toBe(true);
      expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
    });

    it("hands back when the reset THROWS (the fail-safe catch must not skip it)", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const git = makeGit({ resetHardToRemoteBase: vi.fn().mockRejectedValue(new Error("origin/main missing")) });
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
      expect(out.moved).toBe(false);
      expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
    });

    it("hands back when the remote-heal force-push fails (reset already landed)", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const git = makeGit({ forcePush: vi.fn().mockRejectedValue(new Error("(stale info)")) });
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
      expect(out.moved).toBe(true);
      expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
    });

    it("hands back on a post-fetch TOCTOU bail (the fetch's own .git writes count)", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const getHeadHash = vi
        .fn()
        .mockResolvedValueOnce(MERGED_SHA)
        .mockResolvedValue("deadbeef0000000000000000000000000000beef");
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ createGitManager: () => makeGit({ getHeadHash }) }),
        "s1",
        "/ws",
      );
      expect(out.moved).toBe(false);
      expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
    });

    it.each([
      ["the global setting is off", { getAutoResetMergedBranch: () => false }, undefined],
      ["the per-send intent is false", {}, false],
    ] as const)("does NOT walk the worktree when %s (never touched git)", async (_label, over, intent) => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      await autoResetMergedBranchOnContinue(makeDeps(over), "s1", "/ws", intent);
      expect(handWorkspaceBackToWorker).not.toHaveBeenCalled();
    });

    it("does NOT walk the worktree when the pre-fetch gate fails (never touched git)", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const git = makeGit({ isClean: vi.fn().mockResolvedValue(false) });
      await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
      expect(git.fetch).not.toHaveBeenCalled();
      expect(handWorkspaceBackToWorker).not.toHaveBeenCalled();
    });
  });

  describe("skip reporting (planning#297)", () => {
    it.each([
      ["dirty-tree", { isClean: vi.fn().mockResolvedValue(false) }, "uncommitted changes"],
      ["detached-head", { currentBranchOrNull: vi.fn().mockResolvedValue(null) }, "HEAD is detached"],
      ["wrong-branch", { currentBranchOrNull: vi.fn().mockResolvedValue("shipit/other") }, "shipit/other"],
      ["rebase-in-progress", { isRebaseInProgress: vi.fn().mockResolvedValue(true) }, "rebase is in progress"],
      ["sequencer-in-progress", { isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(true) }, "cherry-pick"],
      ["head-moved", { getHeadHash: vi.fn().mockResolvedValue("deadbeef000000000000000000000000000beef1") }, "moved since the merge"],
    ] as const)("names the %s clause and builds a warn notice", async (clause, over, phrase) => {
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ createGitManager: () => makeGit(over) }),
        "s1",
        "/ws",
      );
      expect(out.moved).toBe(false);
      expect(out.skip?.clause).toBe(clause);
      expect(out.skip?.level).toBe("warn");
      expect(out.skip?.detail).toContain(phrase);
      expect(out.skip?.notice).toContain("#482");
      expect(out.skip?.notice).toContain(phrase);
      expect(out.skip?.notice).toContain("will not auto-push");
      expect(out.agentPrefix).toContain("already merged");
      expect(out.agentPrefix).toContain("no open pull request");
    });

    it.each([
      [
        "no-merged-head-sha",
        (): SessionInfo => { const s = makeSession(); delete s.mergedHeadSha; return s; },
        (): PrStatusSummary | null => makePrStatus(),
      ],
      ["no-base-branch", (): SessionInfo => makeSession(), (): PrStatusSummary | null => null],
    ] as const)("reports the %s clause (a merged session ShipIt cannot safely reset)", async (clause, session, prStatus) => {
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ getSession: session, getPrStatus: prStatus, createGitManager: () => makeGit() }),
        "s1",
        "/ws",
      );
      expect(out.skip?.clause).toBe(clause);
      expect(out.skip?.level).toBe("warn");
      expect(out.skip?.notice).toContain("not updated to the latest base");
    });

    it("moves nothing, and says nothing, when the branch is already at the base tip", async () => {
      const git = makeGit({
        getHeadHash: vi.fn().mockResolvedValue(BASE_TIP),
        getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
        isAncestor: vi.fn().mockResolvedValue(true),
      });
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ createGitManager: () => git }), "s1", "/ws",
      );
      expect(out.moved).toBe(false);
      expect(out.skip).toBeUndefined();
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    });

    it("falls back to the previousMergedPr breadcrumb when the live snapshot was re-armed away", async () => {
      const session = makeSession({
        previousMergedPr: { number: 1963, url: "https://github.com/o/r/pull/1963", title: "T", baseBranch: "main" },
      });
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ getSession: () => session, getPrStatus: () => null, createGitManager: () => makeGit() }),
        "s1",
        "/ws",
      );
      expect(out.skip?.notice).toContain("#1963");
      expect(out.skip?.notice).toContain("origin/main");
    });

    it.each([
      ["the global setting is off", { getAutoResetMergedBranch: () => false }, undefined, "setting-off"],
      ["the per-send control was unticked", {}, false, "opted-out"],
    ] as const)("reports %s at info level (a deliberate choice, still recorded)", async (_label, over, intent, clause) => {
      const out = await autoResetMergedBranchOnContinue(makeDeps(over), "s1", "/ws", intent);
      expect(out.moved).toBe(false);
      expect(out.skip?.clause).toBe(clause);
      expect(out.skip?.level).toBe("info");
      expect(out.skip?.notice).toContain("not updated to the latest base");
    });

    it("stays silent for a session that never merged (not a failure mode)", async () => {
      const session = makeSession();
      delete session.mergedAt;
      const out = await autoResetMergedBranchOnContinue(
        makeDeps({ getSession: () => session, createGitManager: () => makeGit() }),
        "s1",
        "/ws",
      );
      expect(out.moved).toBe(false);
      expect(out.skip).toBeUndefined();
      expect(out.agentPrefix).toBeUndefined();
    });

    it("reports a post-fetch TOCTOU bail too (the tree was dirtied mid-flight)", async () => {
      const isClean = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
      const git = makeGit({ isClean });
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
      expect(git.fetch).toHaveBeenCalledOnce();
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
      expect(out.skip?.clause).toBe("dirty-tree");
    });

    it("logs one greppable [pre-turn-reset] line per skip", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await autoResetMergedBranchOnContinue(
        makeDeps({ createGitManager: () => makeGit({ isClean: vi.fn().mockResolvedValue(false) }) }),
        "s1",
        "/ws",
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[pre-turn-reset] skipped for s1 (dirty-tree)"));
      warn.mockRestore();
    });

    describe("the dirty-tree refusal names the files (planning#341)", () => {
      function dirtyGit(paths: string[]): GitManager {
        return makeGit({
          isClean: vi.fn().mockResolvedValue(false),
          uncommittedPaths: vi.fn().mockResolvedValue(paths),
        });
      }

      it("lists the uncommitted paths in the notice, the agent prefix and the log line", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const out = await autoResetMergedBranchOnContinue(
          makeDeps({ createGitManager: () => dirtyGit(["src/b.ts", "docs/a.md"]) }),
          "s1",
          "/ws",
        );
        expect(out.skip?.clause).toBe("dirty-tree");
        expect(out.skip?.detail).toContain("uncommitted paths: docs/a.md, src/b.ts");
        expect(out.skip?.notice).toContain("uncommitted paths: docs/a.md, src/b.ts");
        expect(out.agentPrefix).toContain("uncommitted paths: docs/a.md, src/b.ts");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("uncommitted paths: docs/a.md, src/b.ts"));
        warn.mockRestore();
      });

      it("caps the list at 10 paths and counts the rest", async () => {
        const paths = Array.from({ length: 14 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
        const out = await autoResetMergedBranchOnContinue(
          makeDeps({ createGitManager: () => dirtyGit(paths) }),
          "s1",
          "/ws",
        );
        expect(out.skip?.notice).toContain("src/f09.ts (+4 more)");
        expect(out.skip?.notice).not.toContain("src/f10.ts");
      });

      it("degrades to the bare sentence rather than losing the refusal", async () => {
        const git = makeGit({
          isClean: vi.fn().mockResolvedValue(false),
          uncommittedPaths: vi.fn().mockRejectedValue(new Error("git status boom")),
        });
        const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
        expect(out.skip?.clause).toBe("dirty-tree");
        expect(out.skip?.detail).toContain("uncommitted changes");
        expect(out.skip?.detail).not.toContain("uncommitted paths");
      });

      it("costs nothing on the healthy path (no second git status when the tree is clean)", async () => {
        const git = makeGit();
        await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => git }), "s1", "/ws");
        expect(git.uncommittedPaths).not.toHaveBeenCalled();
      });
    });

    it("says nothing on a successful move (the branch-updated card is the record there)", async () => {
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => makeGit() }), "s1", "/ws");
      expect(out.moved).toBe(true);
      expect(out.skip).toBeUndefined();
    });
  });
});

describe("isResetEligible (composer-control signal)", () => {
  function makeDeps(over: Partial<Omit<PreTurnResetDeps, "getAutoResetMergedBranch">> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }

  it("is true for a merged, untouched, clean branch (safety-only — ignores the setting)", async () => {
    expect(await isResetEligible(makeDeps(), "s1", "/ws")).toBe(true);
  });

  it("cheap-exits to false for a non-merged session without constructing git", async () => {
    const createGitManager = vi.fn(() => makeGit());
    const s = makeSession();
    delete s.mergedAt;
    const eligible = await isResetEligible(makeDeps({ getSession: () => s, createGitManager }), "s1", "/ws");
    expect(eligible).toBe(false);
    expect(createGitManager).not.toHaveBeenCalled();
  });

  it("is false when the branch moved off the merged tip", async () => {
    const git = makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef") });
    expect(await isResetEligible(makeDeps({ createGitManager: () => git }), "s1", "/ws")).toBe(false);
  });

  it("is fail-safe false on a git throw", async () => {
    const git = makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git boom")) });
    expect(await isResetEligible(makeDeps({ createGitManager: () => git }), "s1", "/ws")).toBe(false);
  });
});

describe("announceResetStateOnMerge (say it when the PR merges)", () => {
  function makeRunner(over: Record<string, unknown> = {}): MergeNoticeRunner {
    return {
      emitMessage: vi.fn(),
      running: false,
      chatMessageGroups: [],
      recordedCards: [],
      steeredMessages: [],
      lastPersistedBufferIndex: 0,
      ...over,
    } as unknown as MergeNoticeRunner;
  }

  function makeHistory() {
    return { append: vi.fn(), replaceInProgress: vi.fn() };
  }

  function makeDeps(over: Partial<Omit<PreTurnResetDeps, "getAutoResetMergedBranch">> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }

  const dirtyGit = (paths: string[] = ["src/a.ts"]): GitManager =>
    makeGit({
      isClean: vi.fn().mockResolvedValue(false),
      uncommittedPaths: vi.fn().mockResolvedValue(paths),
    });

  it("still pushes the reset_eligible signal to the runner's viewers", async () => {
    const runner = makeRunner();
    await announceResetStateOnMerge(
      { ...makeDeps(), chatHistory: makeHistory() },
      { sessionId: "s1", sessionDir: "/ws", runner },
    );
    expect(runner.emitMessage).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: true });
  });

  it("says nothing when the gate is happy (the control appearing IS the message)", async () => {
    const chatHistory = makeHistory();
    await announceResetStateOnMerge(
      { ...makeDeps(), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner: makeRunner() },
    );
    expect(chatHistory.append).not.toHaveBeenCalled();
    expect(chatHistory.replaceInProgress).not.toHaveBeenCalled();
  });

  it("persists a warn notice naming the PR, the base and the refusal when the gate refuses", async () => {
    const chatHistory = makeHistory();
    const runner = makeRunner();
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit(["src/b.ts", "docs/a.md"]) }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner },
    );
    expect(chatHistory.append).toHaveBeenCalledOnce();
    const [sid, row] = chatHistory.append.mock.calls[0] as [string, { text: string; noticeLevel: string; notice: boolean }];
    expect(sid).toBe("s1");
    expect(row.notice).toBe(true);
    expect(row.noticeLevel).toBe("warn");
    expect(row.text).toContain("#482");
    expect(row.text).toContain("just merged into main");
    expect(row.text).toContain("uncommitted paths: docs/a.md, src/b.ts");
    expect(row.text).toContain("will not be auto-pushed");
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "system_notice", sessionId: "s1", level: "warn" }),
    );
  });

  it("persists the notice even with NO live runner (the transcript is the durable surface)", async () => {
    const chatHistory = makeHistory();
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    );
    expect(chatHistory.append).toHaveBeenCalledOnce();
  });

  it("takes the in-turn persistence route when a turn is running (the incident's own case)", async () => {
    const chatHistory = makeHistory();
    const runner = makeRunner({ running: true });
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner },
    );
    expect(chatHistory.replaceInProgress).toHaveBeenCalledOnce();
    expect(chatHistory.append).not.toHaveBeenCalled();
  });

  it.each([
    ["dirty-tree", { isClean: vi.fn().mockResolvedValue(false) }],
    ["detached-head", { currentBranchOrNull: vi.fn().mockResolvedValue(null) }],
    ["wrong-branch", { currentBranchOrNull: vi.fn().mockResolvedValue("shipit/other") }],
    ["rebase-in-progress", { isRebaseInProgress: vi.fn().mockResolvedValue(true) }],
    ["sequencer-in-progress", { isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(true) }],
    ["head-moved", { getHeadHash: vi.fn().mockResolvedValue("deadbeef000000000000000000000000000beef1") }],
  ] as const)("notifies for the %s clause", async (_clause, over) => {
    const chatHistory = makeHistory();
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => makeGit(over) }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    );
    expect(chatHistory.append).toHaveBeenCalledOnce();
  });

  it("stays silent for a session with no merged pull request", async () => {
    const chatHistory = makeHistory();
    const session = makeSession();
    delete session.mergedAt;
    await announceResetStateOnMerge(
      { ...makeDeps({ getSession: () => session, createGitManager: () => dirtyGit() }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    );
    expect(chatHistory.append).not.toHaveBeenCalled();
  });

  it("reports a dropped notice loudly when no chat history is wired", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory: undefined },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("was DROPPED"));
    error.mockRestore();
  });

  it("logs one greppable line per merge-time skip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory: makeHistory() },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[pre-turn-reset] merge-detected skip for s1 (dirty-tree)"),
    );
    warn.mockRestore();
  });

  it("notifies for the clauses that need no git failure (no-base-branch, no-merged-head-sha)", async () => {
    for (const over of [
      { getPrStatus: () => null },
      { getSession: (): SessionInfo => { const s = makeSession(); delete s.mergedHeadSha; return s; } },
    ]) {
      clearResetSkipEpisode("s1");
      const chatHistory = makeHistory();
      await announceResetStateOnMerge(
        { ...makeDeps(over), chatHistory },
        { sessionId: "s1", sessionDir: "/ws", runner: null },
      );
      expect(chatHistory.append).toHaveBeenCalledOnce();
    }
  });

  it("swallows a throwing viewer transport instead of aborting post-merge work", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = makeRunner({ emitMessage: vi.fn(() => { throw new Error("dead socket"); }) });
    await expect(announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory: makeHistory() },
      { sessionId: "s1", sessionDir: "/ws", runner },
    )).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("is fail-safe: a git throw reports nothing rather than propagating", async () => {
    const git = makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git boom")) });
    const chatHistory = makeHistory();
    await expect(announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => git }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner: null },
    )).resolves.toBeUndefined();
    expect(chatHistory.append).not.toHaveBeenCalled();
  });

  describe("no double-notify", () => {
    async function announceDirty(over: Partial<Record<keyof GitManager, unknown>> = {}): Promise<void> {
      await announceResetStateOnMerge(
        { ...makeDeps({ createGitManager: () => makeGit({ isClean: vi.fn().mockResolvedValue(false), ...over }) }), chatHistory: makeHistory() },
        { sessionId: "s1", sessionDir: "/ws", runner: null },
      );
    }

    function preTurnDeps(over: Partial<PreTurnResetDeps> = {}): PreTurnResetDeps {
      return {
        getSession: () => makeSession(),
        getPrStatus: () => makePrStatus(),
        createGitManager: () => makeGit({ isClean: vi.fn().mockResolvedValue(false) }),
        getAutoResetMergedBranch: () => true,
        ...over,
      };
    }

    it("drops the pre-turn repeat of a clause merge detection already reported", async () => {
      await announceDirty();
      const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws");
      expect(out.skip?.clause).toBe("dirty-tree");
      expect(out.skip?.notice).toBeUndefined();
      expect(out.agentPrefix).toContain("already merged");
    });

    it("says it again when the refusal becomes a DIFFERENT clause", async () => {
      await announceDirty();
      const out = await autoResetMergedBranchOnContinue(
        preTurnDeps({
          createGitManager: () => makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef000000000000000000000000000beef1") }),
        }),
        "s1",
        "/ws",
      );
      expect(out.skip?.clause).toBe("head-moved");
      expect(out.skip?.notice).toContain("not updated to the latest base");
    });

    it("starts a fresh episode once the branch actually moves", async () => {
      await announceDirty();
      const moved = await autoResetMergedBranchOnContinue(preTurnDeps({ createGitManager: () => makeGit() }), "s1", "/ws");
      expect(moved.moved).toBe(true);
      const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws");
      expect(out.skip?.notice).toContain("not updated to the latest base");
    });

    it("keeps reporting the per-send opt-out, which is a fact about THIS message", async () => {
      await announceDirty();
      for (const _ of [1, 2]) {
        const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws", false);
        expect(out.skip?.clause).toBe("opted-out");
        expect(out.skip?.notice).toContain("not updated to the latest base");
      }
      const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws");
      expect(out.skip?.clause).toBe("dirty-tree");
      expect(out.skip?.notice).toBeUndefined();
    });

    it("says it again for a LATER merge with the same clause and no clear in between", async () => {
      await announceDirty();
      const second = makeSession({ mergedHeadSha: "cafe000000000000000000000000000000000fed" });
      const chatHistory = makeHistory();
      await announceResetStateOnMerge(
        {
          ...makeDeps({
            getSession: () => second,
            createGitManager: () => makeGit({ isClean: vi.fn().mockResolvedValue(false) }),
          }),
          chatHistory,
        },
        { sessionId: "s1", sessionDir: "/ws", runner: null },
      );
      expect(chatHistory.append).toHaveBeenCalledOnce();
    });

    it("leaves the pre-turn notice free when the merge-time delivery failed", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const chatHistory = { append: vi.fn(() => { throw new Error("db closed"); }), replaceInProgress: vi.fn() };
      await announceResetStateOnMerge(
        { ...makeDeps({ createGitManager: () => makeGit({ isClean: vi.fn().mockResolvedValue(false) }) }), chatHistory },
        { sessionId: "s1", sessionDir: "/ws", runner: null },
      );
      const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws");
      expect(out.skip?.notice).toContain("not updated to the latest base");
      error.mockRestore();
    });
  });
});

describe("emitResetEligible (the one emit path, and its log line)", () => {
  function makeDeps(over: Partial<Omit<PreTurnResetDeps, "getAutoResetMergedBranch">> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }

  it("logs the value and the origin for a merged session", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const emit = vi.fn();
    await emitResetEligible(makeDeps(), { sessionId: "s1", sessionDir: "/ws", origin: "activation", emit });
    expect(emit).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reset_eligible=true for s1 (activation)"));
    log.mockRestore();
  });

  it("logs the clause that refused, including the dirty paths", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const git = makeGit({
      isClean: vi.fn().mockResolvedValue(false),
      uncommittedPaths: vi.fn().mockResolvedValue(["src/app.ts"]),
    });
    await emitResetEligible(makeDeps({ createGitManager: () => git }), {
      sessionId: "s1", sessionDir: "/ws", origin: "file-change", emit: vi.fn(),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reset_eligible=false for s1 (file-change): dirty-tree"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("uncommitted paths: src/app.ts"));
    log.mockRestore();
  });

  it("stays out of the log for a non-merged session (a constant false is not news)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const emit = vi.fn();
    const s = makeSession();
    delete s.mergedAt;
    await emitResetEligible(makeDeps({ getSession: () => s }), {
      sessionId: "s1", sessionDir: "/ws", origin: "post-turn", emit,
    });
    expect(emit).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: false });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("reset_eligible"));
    log.mockRestore();
  });

  it("pushes an unchanged value rather than suppressing it (the cross-emitter wedge)", async () => {
    const emit = vi.fn();
    for (let i = 0; i < 3; i++) {
      await emitResetEligible(makeDeps(), { sessionId: "s1", sessionDir: "/ws", origin: "file-change", emit });
    }
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: true });
  });

  it("records a git failure on a merged session instead of an unexplained false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const emit = vi.fn();
    const git = makeGit({ isClean: vi.fn().mockRejectedValue(new Error("git boom")) });
    await emitResetEligible(makeDeps({ createGitManager: () => git }), {
      sessionId: "s1", sessionDir: "/ws", origin: "file-change", emit,
    });
    expect(emit).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("computation failed (git boom)"));
    log.mockRestore();
  });
});

describe("resetBranchToBaseExplicit (docs/239)", () => {
  function makeDeps(over: Partial<PreTurnResetDeps> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }
  function gitWith(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
    return makeGit({ getRefHash: vi.fn().mockResolvedValue(BASE_TIP), ...over });
  }

  it("resets and force-updates the remote, ignoring the docs/218 setting entirely", async () => {
    const git = gitWith();
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("reset");
    expect(result.base).toBe("main");
    expect(result.fromSha).toBe(MERGED_SHA);
    expect(result.toSha).toBe(BASE_TIP);
    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    expect(git.forcePush).toHaveBeenCalled();
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      "/ws",
      expect.stringContaining("main"),
      expect.any(Function),
    );
  });

  it("is idempotent: a second invocation reports already-at-base, not a refusal", async () => {
    const git = gitWith({ getHeadHash: vi.fn().mockResolvedValue(BASE_TIP) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("already-at-base");
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("still reports already-at-base when a docs/218 reset already cleared mergedHeadSha", async () => {
    const session = makeSession();
    delete session.mergedHeadSha;
    const git = gitWith({ getHeadHash: vi.fn().mockResolvedValue(BASE_TIP) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ getSession: () => session, createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("already-at-base");
  });

  it("refuses on a dirty working tree", async () => {
    const git = gitWith({ isClean: vi.fn().mockResolvedValue(false) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/uncommitted/i);
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("refuses when HEAD moved off the merged tip (unmerged work)", async () => {
    const git = gitWith({
      getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000cc"),
      getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  describe("the refusal names the clause that refused", () => {
    const CASES: { clause: string; git: Partial<Record<keyof GitManager, unknown>>; matches: RegExp }[] = [
      { clause: "dirty-tree", git: { isClean: vi.fn().mockResolvedValue(false) }, matches: /uncommitted changes/i },
      { clause: "detached-head", git: { currentBranchOrNull: vi.fn().mockResolvedValue(null) }, matches: /HEAD is detached/i },
      { clause: "wrong-branch", git: { currentBranchOrNull: vi.fn().mockResolvedValue("shipit/other") }, matches: /not the session branch/i },
      { clause: "rebase-in-progress", git: { isRebaseInProgress: vi.fn().mockResolvedValue(true) }, matches: /rebase is in progress/i },
      { clause: "sequencer-in-progress", git: { isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(true) }, matches: /cherry-pick/i },
      {
        clause: "head-moved",
        git: { getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000cc") },
        matches: /moved since the merge/i,
      },
    ];

    for (const { clause, git: over, matches } of CASES) {
      it(`${clause}: the reason carries its own detail, and the log names the clause`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const result = await resetBranchToBaseExplicit(
          makeDeps({ createGitManager: () => gitWith(over) }), "s1", "/ws",
        );
        expect(result.outcome).toBe("refused");
        expect(result.reason).toMatch(matches);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[branch-reset] refused for s1 (${clause})`));
        warn.mockRestore();
      });
    }

    it("offers --force only for the clauses --force actually bypasses", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const gate = await resetBranchToBaseExplicit(
        makeDeps({
          createGitManager: () => gitWith({ getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000cc") }),
        }),
        "s1",
        "/ws",
      );
      expect(gate.reason).toMatch(/--force/);

      const dirty = await resetBranchToBaseExplicit(
        makeDeps({ createGitManager: () => gitWith({ isClean: vi.fn().mockResolvedValue(false) }) }), "s1", "/ws",
      );
      expect(dirty.reason).toMatch(/`--force` does not bypass/);
      warn.mockRestore();
    });
  });

  it("refuses on a detached HEAD", async () => {
    const git = gitWith({ currentBranchOrNull: vi.fn().mockResolvedValue(null) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/detached/i);
  });

  it("refuses while a sequencer (merge / cherry-pick / revert) is in progress", async () => {
    const git = gitWith({ isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(true) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
  });

  it("reports a failed force-push as FAILURE, not success", async () => {
    const git = gitWith({ forcePush: vi.fn().mockRejectedValue(new Error("stale info")) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/stale info/);
  });

  it("hands workspace ownership back to the worker on EVERY path", async () => {
    vi.mocked(handWorkspaceBackToWorker).mockClear();
    await resetBranchToBaseExplicit(makeDeps({ createGitManager: () => gitWith() }), "s1", "/ws");
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");

    vi.mocked(handWorkspaceBackToWorker).mockClear();
    await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => gitWith({ isClean: vi.fn().mockResolvedValue(false) }) }),
      "s1",
      "/ws",
    );
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");

    vi.mocked(handWorkspaceBackToWorker).mockClear();
    await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => { throw new Error("git exploded"); } }),
      "s1",
      "/ws",
    );
    expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
  });

  describe("base derivation survives a docs/202 re-arm", () => {
    function reArmedSession(over: Partial<SessionInfo> = {}): SessionInfo {
      const s = makeSession(over);
      delete s.mergedAt;
      delete s.mergedHeadSha;
      s.previousMergedPr = {
        number: 482,
        url: "https://github.com/o/r/pull/482",
        title: "Fix login redirect",
        baseBranch: "main",
        mergedHeadSha: MERGED_SHA,
      };
      return s;
    }

    it("reports already-at-base from previousMergedPr when pr_status is null", async () => {
      const git = gitWith({ getHeadHash: vi.fn().mockResolvedValue(BASE_TIP) });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => reArmedSession(), getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("already-at-base");
      expect(result.base).toBe("main");
      expect(git.fetch).toHaveBeenCalledWith("origin");
    });

    it("refuses a re-armed branch that genuinely carries unshipped work, naming head-moved", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const git = gitWith({
        getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000cc"),
        isAncestor: vi.fn().mockResolvedValue(false),
      });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => reArmedSession(), getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/moved since the merge/i);
      expect(result.reason).not.toMatch(/no pull-request base/i);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("(head-moved)"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("(not-merged)"));
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("resets a re-armed branch that is BEHIND the base — the state the old test could not tell apart", async () => {
      const git = gitWith({
        getHeadHash: vi.fn().mockResolvedValue("484318fd4d36582291b86e56a88528e93faf7827"),
        isAncestor: vi.fn().mockResolvedValue(true),
      });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => reArmedSession(), getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("reset");
      expect(result.base).toBe("main");
      expect(result.forced).toBeUndefined();
      expect(git.isAncestor).toHaveBeenCalledWith(
        "484318fd4d36582291b86e56a88528e93faf7827",
        "origin/main",
      );
      expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    });

    it("passes the gate on the breadcrumb's merged-head anchor after a re-arm cleared the column", async () => {
      const session = reArmedSession();
      const git = gitWith({ getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA) });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => session, getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("reset");
      expect(result.forced).toBeUndefined();
    });

    it("still refuses for a session that never had a PR, naming the gate as the reason", async () => {
      const session = makeSession();
      delete session.mergedAt;
      delete session.mergedHeadSha;
      const git = gitWith();
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => session, getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/no proof|already shipped/i);
      expect(result.reason).not.toMatch(/merged pull request recorded/i);
      expect(git.fetch).not.toHaveBeenCalled();
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    });

    it("says which base is missing when a CURRENTLY merged session has only an older breadcrumb", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = makeSession({
        previousMergedPr: {
          number: 100,
          url: "https://github.com/o/r/pull/100",
          title: "Older PR",
          baseBranch: "release/v1",
        },
      });
      const git = gitWith();
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => session, getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/#100/);
      expect(result.reason).toMatch(/release\/v1/);
      expect(result.reason).toMatch(/different pull request/i);
      expect(result.reason).not.toMatch(/neither a live pull request nor a previously merged one/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("(no-base-branch)"));
      expect(git.fetch).not.toHaveBeenCalled();
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("prefers the LIVE snapshot over the breadcrumb when both exist", async () => {
      const git = gitWith();
      const session = makeSession({
        previousMergedPr: {
          number: 100,
          url: "https://github.com/o/r/pull/100",
          title: "Older PR",
          baseBranch: "stale-base",
        },
      });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => session, createGitManager: () => git }), "s1", "/ws",
      );
      expect(result.outcome).toBe("reset");
      expect(result.base).toBe("main");
      expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    });
  });

  it("the refusal guidance says WHY and forbids a hand-rolled reset", () => {
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/git reset --hard/);
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/do not|Do NOT/);
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/destroy|recover/i);
  });
});

describe("merge → reset → re-arm → reset-to-base (docs/202 × docs/239 seam)", () => {
  let dbManager: DatabaseManager | undefined;
  let poller: PrStatusPoller | undefined;

  afterEach(() => {
    poller?.destroy();
    poller = undefined;
    dbManager?.close();
    dbManager = undefined;
  });

  it("keeps finding the base after a re-arm clears the live PR snapshot", async () => {
    dbManager = new DatabaseManager(":memory:");
    const sessionManager = new SessionManager(dbManager);
    sessionManager.track("s1", "Fix login redirect");
    sessionManager.setRemoteUrl("s1", "https://github.com/o/r.git");
    sessionManager.setBranch("s1", "shipit/fix-login");
    sessionManager.setPrStatus("s1", makePrStatus());
    sessionManager.markMerged("s1");
    sessionManager.setMergedHeadSha("s1", MERGED_SHA);

    poller = new PrStatusPoller({
      githubAuth: makeGitHubAuth(),
      sessionManager,
      sseBroadcast: vi.fn(),
    });
    poller.loadPersisted();

    let head = MERGED_SHA;
    const git = makeGit({
      getHeadHash: vi.fn(async () => head),
      getRefHash: vi.fn(async () => BASE_TIP),
      resetHardToRemoteBase: vi.fn(async () => {
        const from = head;
        head = BASE_TIP;
        return { from, to: BASE_TIP };
      }),
      headIsAtBase: vi.fn(async () => head === BASE_TIP),
    });
    const deps = {
      getSession: (id: string) => sessionManager.get(id),
      getPrStatus: (id: string) => sessionManager.getPrStatus(id),
      createGitManager: () => git,
    };

    const first = await resetBranchToBaseExplicit(deps, "s1", "/ws");
    expect(first).toMatchObject({ outcome: "reset", base: "main" });

    const reArmed = await detectAndReArmResetSession({
      deps: {
        sessionManager,
        prStatusPoller: poller,
        createGitManager: () => git,
        sseBroadcast: vi.fn(),
      },
      sessionId: "s1",
      sessionDir: "/ws",
      emit: vi.fn(),
    });
    expect(reArmed).toBe(true);

    expect(sessionManager.getPrStatus("s1")).toBeNull();
    expect(sessionManager.get("s1")?.previousMergedPr?.baseBranch).toBe("main");
    expect(sessionManager.get("s1")?.mergedHeadSha).toBeUndefined();
    expect(sessionManager.get("s1")?.previousMergedPr?.mergedHeadSha).toBe(MERGED_SHA);

    const second = await resetBranchToBaseExplicit(deps, "s1", "/ws");
    expect(second).toMatchObject({ outcome: "already-at-base", base: "main" });
  });
});
