/**
 * docs/282 — the pre-turn merge recheck.
 *
 * Two things are worth testing and they pull in opposite directions: that the
 * recheck FIRES in the state the production race happens in (an open pull
 * request, a clean fully-pushed branch), and that it spends no GitHub round-trip
 * in any state where a fresher answer could not change what the gate does. The
 * second is most of this file, because the cost of the fix is the thing that
 * decides whether it may run on every turn.
 */
import { describe, it, expect, vi } from "vitest";
import {
  recheckMergeBeforeTurn,
  type PreTurnMergeRecheckDeps,
} from "./pre-turn-merge-recheck.js";
import type { GitManager } from "../../shared/git.js";
import type { SessionInfo } from "../../shared/types.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";

/** The branch tip: local HEAD and `origin/<branch>` agree — the branch is pushed. */
const PUSHED_TIP = "d7cfc48000000000000000000000000000000001";

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Browser game performance benchmark",
    createdAt: "2026-08-22T18:00:00.000Z",
    lastUsedAt: "2026-08-22T19:31:00.000Z",
    remoteUrl: "https://github.com/o/r.git",
    branch: "shipit/browser-game-performance-benchmark",
    ...over,
  };
}

function makePrStatus(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 101,
    prUrl: "https://github.com/o/r/pull/101",
    prTitle: "Benchmark",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "shipit/browser-game-performance-benchmark",
    insertions: 4,
    deletions: 1,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "mergeable",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  };
}

function makeGit(over: Partial<Record<keyof GitManager, unknown>> = {}): GitManager {
  return {
    getHeadHash: vi.fn().mockResolvedValue(PUSHED_TIP),
    getRefHash: vi.fn().mockResolvedValue(PUSHED_TIP),
    isClean: vi.fn().mockResolvedValue(true),
    currentBranchOrNull: vi.fn().mockResolvedValue("shipit/browser-game-performance-benchmark"),
    isRebaseInProgress: vi.fn().mockResolvedValue(false),
    isMergeOrSequencerInProgress: vi.fn().mockResolvedValue(false),
    uncommittedPaths: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as GitManager;
}

interface Harness {
  deps: PreTurnMergeRecheckDeps;
  verifyPrState: ReturnType<typeof vi.fn>;
  awaitMergeHandling: ReturnType<typeof vi.fn>;
}

/** The default harness: a live, unmerged session whose pull request is open. */
function makeHarness(over: {
  session?: SessionInfo | undefined;
  prStatus?: PrStatusSummary | null;
  git?: GitManager;
  verifyPrState?: () => Promise<void>;
  awaitMergeHandling?: () => Promise<void>;
} = {}): Harness {
  const session = "session" in over ? over.session : makeSession();
  const verifyPrState = vi.fn(over.verifyPrState ?? (async () => {}));
  const awaitMergeHandling = vi.fn(over.awaitMergeHandling ?? (async () => {}));
  const deps: PreTurnMergeRecheckDeps = {
    getSession: () => session,
    getPrStatus: () => ("prStatus" in over ? over.prStatus ?? null : makePrStatus()),
    createGitManager: () => over.git ?? makeGit(),
    verifyPrState,
    awaitMergeHandling,
  };
  return { deps, verifyPrState, awaitMergeHandling };
}

const run = (h: Harness, timeoutMs?: number) =>
  recheckMergeBeforeTurn(h.deps, "s1", "/ws", ...(timeoutMs !== undefined ? [{ timeoutMs }] : []));

describe("recheckMergeBeforeTurn — the production race", () => {
  it("discovers a merge the poller has not reached yet, on a clean pushed branch", async () => {
    // The incident's exact shape: commit + push landed, the user merged on
    // GitHub, and the next message arrived before the 15 s poll observed it.
    let session: SessionInfo | undefined = makeSession();
    const verifyPrState = vi.fn(async () => {
      session = { ...session!, mergedAt: "2026-08-22 19:32:02", mergedHeadSha: PUSHED_TIP };
    });
    const deps: PreTurnMergeRecheckDeps = {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      verifyPrState,
      awaitMergeHandling: vi.fn(async () => {}),
    };

    await expect(recheckMergeBeforeTurn(deps, "s1", "/ws")).resolves.toBe("merged");
    expect(verifyPrState).toHaveBeenCalledOnce();
  });

  it("still probes when the remote-tracking ref is missing rather than merely different", async () => {
    // `origin/<session-branch>` can legitimately be absent — a clone restored
    // from the bare cache after GitHub deleted the merged head branch, or any
    // prune — while HEAD is still exactly the commit GitHub merged, which the
    // gate's anchor clause accepts. Reading "unresolvable" as "moved" would skip
    // the probe on a branch the reset could safely have rescued.
    let session: SessionInfo | undefined = makeSession();
    const verifyPrState = vi.fn(async () => {
      session = { ...session!, mergedAt: "2026-08-22 19:32:02", mergedHeadSha: PUSHED_TIP };
    });
    const deps: PreTurnMergeRecheckDeps = {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit({ getRefHash: vi.fn().mockResolvedValue(null) }),
      verifyPrState,
      awaitMergeHandling: vi.fn(async () => {}),
    };

    await expect(recheckMergeBeforeTurn(deps, "s1", "/ws")).resolves.toBe("merged");
  });

  it("waits for the merge bookkeeping, so a probe that lands before `mergedAt` still reports merged", async () => {
    // `verifyMissingPr` records the merged snapshot synchronously but fires the
    // callback that stamps `mergedAt` fire-and-forget. Without the wait, the
    // recheck would read the session a beat too early and answer "not merged"
    // — the same one-beat error as the poll window itself.
    let session: SessionInfo | undefined = makeSession();
    const deps: PreTurnMergeRecheckDeps = {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      verifyPrState: vi.fn(async () => {}),
      awaitMergeHandling: vi.fn(async () => {
        session = { ...session!, mergedAt: "2026-08-22 19:32:02", mergedHeadSha: PUSHED_TIP };
      }),
    };

    await expect(recheckMergeBeforeTurn(deps, "s1", "/ws")).resolves.toBe("merged");
  });

  it("reports not-merged when the pull request is genuinely still open", async () => {
    const h = makeHarness();
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).toHaveBeenCalledOnce();
  });
});

describe("recheckMergeBeforeTurn — states that must not cost a round-trip", () => {
  it("skips a session ShipIt already knows merged (the gate has what it needs)", async () => {
    const h = makeHarness({ session: makeSession({ mergedAt: "2026-08-22 19:32:02" }) });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a session with no observed pull request", async () => {
    const h = makeHarness({ prStatus: null });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a session whose last observation is already terminal", async () => {
    const h = makeHarness({ prStatus: makePrStatus({ prState: "closed" }) });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a workspace-less session", async () => {
    const h = makeHarness({ session: makeSession({ remoteUrl: undefined, branch: undefined }) });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a branch carrying unpushed commits — the gate would refuse `head-moved` anyway", async () => {
    const h = makeHarness({
      git: makeGit({ getRefHash: vi.fn().mockResolvedValue("0000000000000000000000000000000000000009") }),
    });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a dirty tree — the reset's own precondition, so a fresh merge changes nothing", async () => {
    const h = makeHarness({ git: makeGit({ isClean: vi.fn().mockResolvedValue(false) }) });
    await expect(run(h)).resolves.toBe("unchanged");
    expect(h.verifyPrState).not.toHaveBeenCalled();
  });

  it("skips a detached HEAD / mid-rebase workspace", async () => {
    const detached = makeHarness({ git: makeGit({ currentBranchOrNull: vi.fn().mockResolvedValue(null) }) });
    await expect(run(detached)).resolves.toBe("unchanged");
    expect(detached.verifyPrState).not.toHaveBeenCalled();

    const rebasing = makeHarness({ git: makeGit({ isRebaseInProgress: vi.fn().mockResolvedValue(true) }) });
    await expect(run(rebasing)).resolves.toBe("unchanged");
    expect(rebasing.verifyPrState).not.toHaveBeenCalled();
  });
});

describe("recheckMergeBeforeTurn — fail-safe", () => {
  it("swallows a probe failure and leaves the turn on the poller's last known state", async () => {
    const h = makeHarness({ verifyPrState: async () => { throw new Error("502 from GitHub"); } });
    await expect(run(h)).resolves.toBe("unchanged");
  });

  it("gives up on the timeout rather than holding the turn open", async () => {
    const h = makeHarness({ verifyPrState: () => new Promise<void>(() => {}) });
    await expect(run(h, 10)).resolves.toBe("unchanged");
  });

  /**
   * The dangerous timeout, and the reason the outcome is three-valued rather
   * than a boolean. `markMergedAndPruneExcess` stamps `merged_at` FIRST and only
   * then awaits `git push --delete` of the merged head branch, so a budget that
   * expires mid-bookkeeping leaves the session reading as merged with that
   * deletion still in flight. Acting on it would reset the branch and force-push
   * it back for the pending delete to remove — a deleted branch instead of a
   * stranded commit.
   */
  it("reports `unsettled` when the merge landed but its bookkeeping did not finish", async () => {
    let session: SessionInfo | undefined = makeSession();
    const deps: PreTurnMergeRecheckDeps = {
      getSession: () => session,
      getPrStatus: () => makePrStatus(),
      createGitManager: () => makeGit(),
      // The probe records the merge; the bookkeeping never returns.
      verifyPrState: vi.fn(async () => {
        session = { ...session!, mergedAt: "2026-08-22 19:32:02", mergedHeadSha: PUSHED_TIP };
      }),
      awaitMergeHandling: vi.fn(() => new Promise<void>(() => {})),
    };

    await expect(recheckMergeBeforeTurn(deps, "s1", "/ws", { timeoutMs: 10 }))
      .resolves.toBe("unsettled");
  });
});
