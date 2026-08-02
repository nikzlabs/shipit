import { describe, it, expect, vi, afterEach } from "vitest";
import { computeResetEligible, autoResetMergedBranchOnContinue, isResetEligible, emitResetEligibleSignal, resetBranchToBaseExplicit, RESET_REFUSAL_GUIDANCE, type PreTurnResetDeps } from "./pre-turn-reset.js";
import { handWorkspaceBackToWorker } from "../session-worker-uid.js";

vi.mock("../session-worker-uid.js", () => ({ handWorkspaceBackToWorker: vi.fn() }));
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
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/fix-login"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    getHeadHash: vi.fn().mockResolvedValue(MERGED_SHA),
    fetch: vi.fn().mockResolvedValue(undefined),
    resetHardToRemoteBase: vi.fn().mockResolvedValue({ from: MERGED_SHA, to: BASE_TIP }),
    forcePush: vi.fn().mockResolvedValue("Force pushed to origin/shipit/fix-login"),
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

describe("emitResetEligibleSignal (merge-while-viewing push)", () => {
  function makeDeps(over: Partial<Omit<PreTurnResetDeps, "getAutoResetMergedBranch">> = {}) {
    return {
      getSession: () => makeSession(),
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      ...over,
    };
  }

  it("recomputes eligibility and emits reset_eligible to the runner's viewers", async () => {
    const emitMessage = vi.fn();
    await emitResetEligibleSignal(makeDeps(), { sessionDir: "/ws", emitMessage }, "s1");
    expect(emitMessage).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: true });
  });

  it("emits eligible:false when the branch already moved off the merged tip", async () => {
    const emitMessage = vi.fn();
    const git = makeGit({ getHeadHash: vi.fn().mockResolvedValue("deadbeef0000000000000000000000000000beef") });
    await emitResetEligibleSignal(makeDeps({ createGitManager: () => git }), { sessionDir: "/ws", emitMessage }, "s1");
    expect(emitMessage).toHaveBeenCalledWith({ type: "reset_eligible", sessionId: "s1", eligible: false });
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
    /** What a session looks like AFTER `clearMerged` + `reArm`: no live snapshot,
     * no `mergedAt`/`mergedHeadSha`, but a durable breadcrumb naming the base. */
    function reArmedSession(over: Partial<SessionInfo> = {}): SessionInfo {
      const s = makeSession(over);
      delete s.mergedAt;
      delete s.mergedHeadSha;
      s.previousMergedPr = {
        number: 482,
        url: "https://github.com/o/r/pull/482",
        title: "Fix login redirect",
        baseBranch: "main",
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

    it("refuses on the real reason — unshipped work — not on a missing base", async () => {
      // Re-armed AND ahead of the base: a reset would discard commits that were
      // never shipped, so it must still refuse. Only the reason changes.
      const git = gitWith({ getHeadHash: vi.fn().mockResolvedValue("cafe0000000000000000000000000000000000cc") });
      const result = await resetBranchToBaseExplicit(
        makeDeps({ getSession: () => reArmedSession(), getPrStatus: () => null, createGitManager: () => git }),
        "s1",
        "/ws",
      );
      expect(result.outcome).toBe("refused");
      expect(result.reason).toMatch(/not on the merged pull request/i);
      expect(result.reason).not.toMatch(/no pull-request base/i);
      expect(git.resetHardToRemoteBase).not.toHaveBeenCalled();
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

    // 4. A duplicate / later wake must still find the base and exit cleanly.
    //    Before the fix this refused with "no merged pull request recorded".
    const second = await resetBranchToBaseExplicit(deps, "s1", "/ws");
    expect(second).toMatchObject({ outcome: "already-at-base", base: "main" });
  });
});
