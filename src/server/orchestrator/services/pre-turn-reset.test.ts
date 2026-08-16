import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { computeResetEligible, computeResetBlocker, autoResetMergedBranchOnContinue, isResetEligible, emitResetEligible, announceResetStateOnMerge, clearResetSkipEpisode, resetBranchToBaseExplicit, RESET_REFUSAL_GUIDANCE, type PreTurnResetDeps, type MergeNoticeRunner } from "./pre-turn-reset.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";

vi.mock("../session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));
// nikzlabs/shipit#2349: `reset --hard` re-materializes the worktree through the
// ORCHESTRATOR's git, whose LFS smudge filter is disabled by design, so every
// LFS-tracked path it touched becomes ~130-byte pointer text in a tree that
// reports clean. What the restore actually does is proven end-to-end against a
// real git-lfs in `git-lfs.test.ts`; here we assert both reset paths call it.
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

/** A fake GitManager exposing only the methods the gate + helper touch. */
function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    isClean: vi.fn().mockResolvedValue(true),
    uncommittedPaths: vi.fn().mockResolvedValue([]),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    getRefHash: vi.fn().mockResolvedValue(BASE_TIP),
    // The provable-safety clause: false by default (the branch is NOT contained
    // in the base — the ordinary just-merged state), so the anchor clause is
    // what decides. Tests that exercise the clause override it.
    isAncestor: vi.fn().mockResolvedValue(false),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    forcePush: vi.fn().mockResolvedValue("Force pushed to origin/shipit/fix-login"),
    ...over,
  } as unknown as GitManager;
}

/**
 * docs/266 — the notice-suppression episode is module state keyed by session id,
 * and every test here uses "s1". Clear it between tests so one test's refusal
 * cannot silence the next one's notice.
 */
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

  /**
   * The provable-safety clause: a branch fully contained in `origin/<base>`
   * carries nothing a reset could discard, so it needs neither the stored anchor
   * nor an operator's `--force`. This is NOT the shortcut docs/218's plan
   * rejected — a commit made without rebasing leaves HEAD outside the base, so
   * the clause simply does not fire (asserted below).
   */
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
      // New work on top of the merged tip: not contained in the base, so
      // ancestry is false and the anchor clause refuses as it always did.
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

  /**
   * Change 3 — the gate reads the merged record DURABLY. `clearMerged` nulls
   * `merged_at` AND `merged_head_sha` in one statement while `reArm` nulls the
   * live PR snapshot, so every one of those clauses used to refuse for a session
   * that had plainly merged. The breadcrumb carries all three facts.
   */
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
    // Heals the remote so later plain auto-pushes fast-forward (force-with-lease
    // against the live remote tip, resolved inside forcePush via ls-remote).
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
    // The turn this reset exists to enable is about to read those files.
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

  it("still reports moved:true when the remote-heal force-push fails (best-effort)", async () => {
    // A lease rejection / network error during the heal must not undo the reset:
    // the local branch already moved, the turn should run, and the session falls
    // back to the pre-fix divergence (no worse than before) rather than throwing.
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

  /**
   * The reset runs as ROOT against a worktree the uid-1000 worker owns, so every
   * file it re-materializes lands `root:root` and the agent EACCESes on its first
   * edit of this very turn. Nothing else repairs it (the boot chown is
   * sentinel-skipped on warm reuse, `selfHealWorkspaceOwnership` runs only on
   * container re-create, and the post-turn handback is `.git`-only), so these pin
   * the handback on every path that could have re-rooted the tree — and pin the
   * deliberate *absence* of the walk on the read-only paths.
   */
  describe("workspace ownership handback", () => {
    it("hands back after a successful reset", async () => {
      vi.mocked(handWorkspaceBackToWorker).mockClear();
      const out = await autoResetMergedBranchOnContinue(makeDeps({ createGitManager: () => makeGit() }), "s1", "/ws");
      expect(out.moved).toBe(true);
      expect(handWorkspaceBackToWorker).toHaveBeenCalledWith("/ws");
    });

    it("hands back when the reset THROWS (the fail-safe catch must not skip it)", async () => {
      // The worst version of the bug: the tree may already be re-rooted, the catch
      // swallows the error and returns NOT_MOVED, and the turn then runs on a
      // workspace the agent cannot write to. The `finally` is what closes it.
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

    it("hands back on a post-fetch TOCTOU bail (the fetch's own root writes count)", async () => {
      // No reset ran, but `git fetch` as root already wrote FETCH_HEAD, remote
      // refs and new objects into `.git` — hence the flag is set before the fetch,
      // not before the reset.
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

    /**
     * Deliberately scoped, not unconditional: this helper runs on EVERY
     * interactive turn, and the handback is a full worktree walk. Paths that bail
     * before the fetch only ever READ git, so they cannot have re-rooted anything
     * — charging every turn of every session for a no-op walk is the cost this
     * avoids. Pinned so the scoping is explicit rather than incidental.
     */
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

  /**
   * planning#297 — a skip on a MERGED session must never be silent again.
   *
   * The production incident was diagnosed by proving a negative: one session's
   * log showed `[git] Reset --hard`, the broken one showed nothing at all — no
   * card, no prefix, no log line. Meanwhile the branch sat on already-merged
   * commits and the agent, equally unaware, authored a commit for a dead PR.
   * These pin the clause-per-skip contract so the next investigation greps one
   * line and the next user reads one notice.
   */
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
      // The user notice names the merged PR, the refusal, and the consequence.
      expect(out.skip?.notice).toContain("#482");
      expect(out.skip?.notice).toContain(phrase);
      expect(out.skip?.notice).toContain("will not auto-push");
      // The agent learns it too — this is what stops the next commit-for-a-dead-PR.
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
      // The containment clause's degenerate case. Without the short-circuit the
      // turn runs a no-op `reset --hard` and emits a "Branch updated" card whose
      // from === to — and a branch that is already current is not a skip either.
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
      // `PrStatusPoller.reArm` nulls the live snapshot on the ordinary
      // keep-working-after-a-merge path, so the notice must not lose the PR
      // number — same durability problem `resolveResetBase` solves.
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

    /**
     * planning#341 — "the working tree has uncommitted changes" is unactionable when
     * the user did not knowingly change anything. In the motivating incident the
     * writer was a compose service mounting the workspace read-write, so the only
     * way to understand the refusal was to name the files.
     */
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
        // Sorted, so the log line and the notice are stable across runs.
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

/**
 * docs/266 — the merge-time half. A merge that lands on a branch the safety gate
 * will not reset used to tell the user nothing AT THE TIME: the composer control
 * simply stayed hidden, and planning#297's notice waited for their next message. In
 * the incident (session 5203c910, PR #2327) that was 4m45s of silence — exactly
 * the window in which committing and opening a new PR was still cheap.
 */
describe("announceResetStateOnMerge (say it when the PR merges)", () => {
  /** A live runner with the surface `emitNoticeInTurn` touches. */
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
    // The three facts, at the moment they are still cheap to act on.
    expect(row.text).toContain("#482");
    expect(row.text).toContain("just merged into main");
    expect(row.text).toContain("uncommitted paths: docs/a.md, src/b.ts");
    expect(row.text).toContain("will not be auto-pushed");
    // …and it renders live too, for the viewer who is sitting on the session.
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
    // The agent was mid-turn when the PR merged. `emitNoticeInTurn` must record
    // the notice in-band rather than appending it above the running turn's rows.
    const chatHistory = makeHistory();
    const runner = makeRunner({ running: true });
    await announceResetStateOnMerge(
      { ...makeDeps({ createGitManager: () => dirtyGit() }), chatHistory },
      { sessionId: "s1", sessionDir: "/ws", runner },
    );
    expect(chatHistory.replaceInProgress).toHaveBeenCalledOnce();
    expect(chatHistory.append).not.toHaveBeenCalled();
  });

  /**
   * Every clause the SAFETY gate can return on a merged session earns a notice —
   * each one means "your branch was left on already-merged commits". The two
   * consent clauses (`setting-off` / `opted-out`) cannot reach here at all: this
   * gate does not evaluate them.
   */
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

  /**
   * `onMergeDetectedCb` does more after this call (the docs/145 bare-cache
   * refresh). `emitMessage` is an EventEmitter broadcast, so one broken viewer
   * listener must not take the rest of the post-merge work down with it.
   */
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

  /**
   * The suppression rule. One paragraph per refusal EPISODE — the shape
   * `auto-push-scheduler.ts` uses for diverged pushes, because a user who reads
   * the merge-time notice and then sends a message must not read it again.
   */
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
      // The agent is a fresh reader every turn, so its prefix is NOT suppressed —
      // this is what stops the next commit-for-a-dead-PR.
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
      // A clean tree: the reset runs, which ends the episode…
      const moved = await autoResetMergedBranchOnContinue(preTurnDeps({ createGitManager: () => makeGit() }), "s1", "/ws");
      expect(moved.moved).toBe(true);
      // …so the same clause refusing later is news again.
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
      // …and the standing safety episode it did NOT overwrite is still suppressed.
      const out = await autoResetMergedBranchOnContinue(preTurnDeps(), "s1", "/ws");
      expect(out.skip?.clause).toBe("dirty-tree");
      expect(out.skip?.notice).toBeUndefined();
    });

    /**
     * The episode belongs to ONE merge. A second pull request merging into the
     * same unchanged refusal is a NEW fact, and an entry left behind by the
     * first one must not silence it — the resolving paths (both reset modes,
     * both re-arms, an interval that simply became eligible) are too many for
     * "we cleared it everywhere" to be a checkable claim.
     */
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

/**
 * planning#341 — the single emit path for `reset_eligible`. The log line is the point:
 * the ops investigation into a refused reset could not tell "the client held a
 * stale true" from "the tree became dirty later", because neither the emitted
 * value nor its reason was written down anywhere.
 */
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

  /**
   * The client holds ONE value per session and takes whichever message arrived
   * last, so no emitter may suppress a push against a value it remembers
   * privately: an unconditional emitter can have overwritten the client since,
   * and the suppressed push is the only thing that would correct it. A
   * deduplicated variant existed and was deleted after cross-agent review.
   */
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
    // Fail-safe for the UI, but NOT silent — this is the ambiguous operational
    // case the log exists to remove.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("computation failed (git boom)"));
    log.mockRestore();
  });
});

/**
 * docs/239 — the EXPLICIT mode (`shipit branch reset-to-base`). Same core, five
 * deliberate differences from the docs/218 auto path; each test below pins one.
 */
describe("resetBranchToBaseExplicit (docs/239)", () => {
  function makeDeps(over: Partial<PreTurnResetDeps> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }
  /** `getRefHash("origin/<base>")` — absent from the shared fake, added per test. */
  function gitWith(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
    return makeGit({ getRefHash: vi.fn().mockResolvedValue(BASE_TIP), ...over });
  }

  it("resets and force-updates the remote, ignoring the docs/218 setting entirely", async () => {
    const git = gitWith();
    // The auto path reads `getAutoResetMergedBranch`; this mode must not — a
    // command the agent deliberately invoked cannot silently no-op on a
    // composer preference. `PreTurnResetDeps`'s getter isn't even passed here.
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("reset");
    expect(result.base).toBe("main");
    expect(result.fromSha).toBe(MERGED_SHA);
    expect(result.toSha).toBe(BASE_TIP);
    expect(git.resetHardToRemoteBase).toHaveBeenCalledWith("main");
    expect(git.forcePush).toHaveBeenCalled();
    // nikzlabs/shipit#2349 — same duty as the automatic path: the reset rewrote the
    // worktree through a smudge-disabled git, so LFS content has to be restored
    // before the agent's next turn reads it.
    expect(restoreLfsAfterTreeRewrite).toHaveBeenCalledWith(
      "/ws",
      expect.stringContaining("main"),
      expect.any(Function),
    );
  });

  it("is idempotent: a second invocation reports already-at-base, not a refusal", async () => {
    // After the first reset HEAD === the base tip and no longer equals
    // `mergedHeadSha`, so the docs/218 gate would refuse. The already-at-base
    // check runs FIRST precisely so a duplicate wake / retry doesn't end a chain.
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

  /**
   * Change 1 — the refusal names the clause that actually refused.
   *
   * It used to print ONE hard-coded sentence ("carries work that is not on the
   * merged pull request") for all nine clauses. That sentence is true of exactly
   * one of them; for the incident's `not-merged` refusal it sent the agent after
   * a root cause that was wrong in every particular, and on to `--force` for an
   * operation that was provably lossless.
   */
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
        // Change 4 — a refusal used to write nothing at all to the orchestrator
        // log; only a FORCED reset did. The stuck case is the interesting one.
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

      // A dirty tree is not a trust question — pointing the agent at a bypass
      // that refuses again is how a refusal turns into a hand-rolled reset.
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
    // docs/218's heal is best-effort and still returns `moved: true`. Here the
    // remote is left diverged, so every later push is a silently-dropped
    // non-fast-forward and the chain's next PR never updates.
    const git = gitWith({ forcePush: vi.fn().mockRejectedValue(new Error("stale info")) });
    const result = await resetBranchToBaseExplicit(
      makeDeps({ createGitManager: () => git }), "s1", "/ws",
    );
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/stale info/);
  });

  it("hands workspace ownership back to the worker on EVERY path", async () => {
    // The orchestrator did this git work as root; without the handback the agent
    // hits EACCES on its first edit — inside the very turn the wake enables. In a
    // `finally`, so a refusal is covered too.
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

  /**
   * The base derivation, which a docs/202 re-arm used to break: `reArm` nulls the
   * live PR snapshot (`setPrStatus(id, null)`) in the ordinary post-turn flow, so
   * a base read only from `getPrStatus` disappears while the session is plainly
   * still based on `main`. `previousMergedPr.baseBranch` is written by
   * `clearMerged` in the same beat and is DB-backed.
   */
  describe("base derivation survives a docs/202 re-arm", () => {
    /** What a session looks like AFTER `clearMerged` + `reArm`: no live snapshot
     * and no `mergedAt`/`mergedHeadSha` columns, but a durable breadcrumb
     * carrying the base AND the merged-tip anchor (the anchor is what makes the
     * gate reachable at all for this population — see change 3). */
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
      // The live-reproduced failure: the branch is exactly where a reset would put
      // it, so this must be a clean exit-0 — not "no merged pull request recorded".
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

    /**
     * The rewrite of a test that passed for the WRONG reason. It built exactly
     * this fixture, put HEAD ahead of the base, and asserted the refusal said
     * "not on the merged pull request" — but the clause that fired was
     * `not-merged` (the fixture deletes `mergedAt`), so the branch being ahead
     * was never reached and the identical assertion passed when the branch was
     * BEHIND the base, which is the incident case. Both states are asserted
     * here, and they must produce different clauses.
     */
    it("refuses a re-armed branch that genuinely carries unshipped work, naming head-moved", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Ahead of the base and not contained in it: a reset would discard commits
      // that were never shipped, so it must still refuse — and the durable
      // breadcrumb anchor is what lets the gate reach that conclusion at all.
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
      // The clause, not just the prose — this is what tells the two states apart.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("(head-moved)"));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("(not-merged)"));
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("resets a re-armed branch that is BEHIND the base — the state the old test could not tell apart", async () => {
      // The production incident: HEAD a strict ancestor of origin/main, tree
      // clean, base tip ahead. Provably lossless, so no `--force` and no refusal.
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
      // Change 3: `clearMerged` nulls both `merged_at` and `merged_head_sha`, so
      // before the durable copy this session was force-only forever — even
      // sitting untouched on exactly the commit GitHub merged.
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
      // The repo's default branch is knowable (session branches are cut from it),
      // so the refusal must not imply ShipIt merely failed to find a base — the
      // real reason is that `computeResetEligible` requires a merged PR, which is
      // what proves the branch's commits are safe to discard.
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
      // The old copy asserted a merged PR had been recorded when none had.
      expect(result.reason).not.toMatch(/merged pull request recorded/i);
      // Refused before any network or destructive git.
      expect(git.fetch).not.toHaveBeenCalled();
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
    });

    it("says which base is missing when a CURRENTLY merged session has only an older breadcrumb", async () => {
      // `resolveResetBase` declines the breadcrumb while the session is merged —
      // an earlier pull request may have merged into a different branch, and
      // resetting onto the wrong base discards commits that shipped. The refusal
      // must say that, not "no previously merged pull request is recorded",
      // which is the same false-diagnosis class this whole change fixes.
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
      // Unchanged behaviour for the normal path: the breadcrumb is a fallback, and
      // a stale one must never override a live PR's base.
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
    // Load-bearing copy: the gate is prompt-mediated, so a refused agent that is
    // not told to stop can simply `git reset --hard` and cause the exact loss the
    // gate exists to prevent. Structural assertions, not prose matching.
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/git reset --hard/);
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/do not|Do NOT/);
    expect(RESET_REFUSAL_GUIDANCE).toMatch(/destroy|recover/i);
  });
});

/**
 * The whole failing sequence as ONE test, against the REAL SessionManager, the
 * REAL PrStatusPoller and the REAL re-arm helper — only git is stubbed. The bug
 * lived in the seam between them (`reArm` nulls `pr_status`; the reset read the
 * base from `pr_status` alone), so mocking either side would have hidden it.
 */
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
    poller.loadPersisted(); // seeds the merged snapshot, as a restart would

    // Git stub for the whole sequence: HEAD tracks the reset, base tip is fixed.
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

    // 1. The reset itself — works today, from the live snapshot.
    const first = await resetBranchToBaseExplicit(deps, "s1", "/ws");
    expect(first).toMatchObject({ outcome: "reset", base: "main" });

    // 2. The post-turn re-arm the reset triggers (docs/216 every-turn hook).
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

    // 3. The state that broke it, asserted at the source rather than assumed:
    //    the live snapshot is gone, the durable breadcrumb carries the base.
    expect(sessionManager.getPrStatus("s1")).toBeNull();
    expect(sessionManager.get("s1")?.previousMergedPr?.baseBranch).toBe("main");
    //    …and the merged-tip anchor, which `clearMerged` nulls on the column.
    //    Asserted through the REAL SessionManager because the breadcrumb round-
    //    trips through JSON in SQLite: this is the whole durability claim.
    expect(sessionManager.get("s1")?.mergedHeadSha).toBeUndefined();
    expect(sessionManager.get("s1")?.previousMergedPr?.mergedHeadSha).toBe(MERGED_SHA);

    // 4. A duplicate / later wake must still find the base and exit cleanly.
    //    Before the fix this refused with "no merged pull request recorded".
    const second = await resetBranchToBaseExplicit(deps, "s1", "/ws");
    expect(second).toMatchObject({ outcome: "already-at-base", base: "main" });
  });
});
