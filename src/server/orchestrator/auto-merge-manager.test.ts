import { describe, it, expect, vi } from "vitest";

import { AutoMergeManager } from "./auto-merge-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type {
  BranchSyncState,
  PrMergeableState,
  PrReviewDecision,
  PrStatusSummary,
} from "../shared/types/github-types.js";

/**
 * Unit tests for the ShipIt-managed auto-merge executor. The regression these
 * guard against: a PR with no required checks (e.g. a docs-only PR where CI is
 * path-filtered out) reports `checks.state === "none"`. The client already
 * treats `none` as mergeable (docs/113, `isCiPassed || isCiNone`), and native
 * auto-merge falls back to managed mode for such PRs — so the managed executor
 * must finish the merge instead of returning early on the old `=== "success"`
 * gate, which left the PR stuck forever.
 */

type ChecksState = PrStatusSummary["checks"]["state"];

function makeSummary(
  checksState: ChecksState,
  mergeable: PrMergeableState,
  reviewDecision: PrReviewDecision = "none",
): PrStatusSummary {
  return {
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
    prTitle: "docs: update",
    prBody: "",
    prState: "open",
    baseBranch: "main",
    headBranch: "feature",
    insertions: 1,
    deletions: 0,
    checks: { state: checksState, total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable,
    reviewDecision,
    autoMergeEnabled: false,
  } as PrStatusSummary;
}

function makeManager(mergeResult = { success: true, message: "merged" }) {
  const mergePullRequest = vi.fn().mockResolvedValue(mergeResult);
  const githubAuth = { mergePullRequest } as unknown as GitHubAuthManager;
  const onChange = vi.fn();
  const manager = new AutoMergeManager(githubAuth, onChange);
  return { manager, mergePullRequest, onChange };
}

/**
 * A manager wired to a runner whose busy state the test controls, standing in
 * for the runner registry the poller passes in production.
 */
function makeManagerWithRunner(
  runner: { running?: boolean; agentBusy: boolean; systemTurnInProgress?: boolean } | undefined,
) {
  const mergePullRequest = vi.fn().mockResolvedValue({ success: true, message: "merged" });
  const githubAuth = { mergePullRequest } as unknown as GitHubAuthManager;
  const onChange = vi.fn();
  const box = { runner };
  const manager = new AutoMergeManager(
    githubAuth,
    onChange,
    () => box.runner as unknown as SessionRunnerInterface | undefined,
  );
  return { manager, mergePullRequest, onChange, box };
}

describe("AutoMergeManager.handleManaged", () => {
  it("merges a no-checks PR (checks.state === 'none') and marks it completed — regression", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "mergeable"), "o", "r");

    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).toHaveBeenCalledWith("o", "r", 42, "squash");
    // Merge succeeded — auto-merge keeps owning the session (enabled stays true
    // so the client stays silent) and `completed` stops the poller re-driving it
    // until the merged state is observed.
    const state = manager.get("s1");
    expect(state?.enabled).toBe(true);
    expect(state?.completed).toBe(true);
    expect(state?.error).toBeUndefined();
  });

  // Regression (spurious chime): after a successful managed merge, auto-merge
  // must NOT flip to a "user must act" shape before the poller observes the
  // merged PR. `enabled` stays true (the client's suppression key) and a
  // subsequent poll tick re-runs handleManaged without re-merging.
  it("keeps auto-merge owning the session after a successful merge and does not re-merge", async () => {
    const { manager, mergePullRequest, onChange } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(manager.get("s1")?.enabled).toBe(true);

    onChange.mockClear();
    // The poller re-broadcasts `lastKnown` (still open+green) on the next tick.
    await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

    // No second merge attempt, no further state churn — the session stays
    // suppressed until the merged state lands.
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(manager.get("s1")?.enabled).toBe(true);
    expect(manager.get("s1")?.completed).toBe(true);
  });

  it("defers a no-checks PR while mergeability is 'unknown' (does NOT merge)", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "unknown"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    // Stays enabled so a later poll tick can retry once GitHub computes mergeability.
    expect(manager.get("s1")?.enabled).toBe(true);
  });

  it("does NOT merge while checks are pending", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("pending", "mergeable"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(manager.get("s1")?.enabled).toBe(true);
  });

  it("does NOT merge when checks failed", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("failure", "mergeable"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("still merges when checks pass (checks.state === 'success') — unchanged behavior", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(manager.get("s1")?.completed).toBe(true);
  });

  // docs/174 — review gate. A protected base branch reports review_required /
  // changes_requested until satisfied; merging would be rejected every tick, so
  // bail without a sticky error (awaiting approval is a normal transient wait).
  it.each(["review_required", "changes_requested"] as const)(
    "does NOT merge when reviewDecision is %s, even with CI green",
    async (reviewDecision) => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable", reviewDecision), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
      // No sticky error — re-evaluated next poll once an approval lands.
      expect(manager.get("s1")?.error).toBeUndefined();
      expect(manager.get("s1")?.enabled).toBe(true);
    },
  );

  it("merges when reviewDecision is 'approved' and CI passes", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("success", "mergeable", "approved"), "o", "r");

    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(manager.get("s1")?.completed).toBe(true);
  });

  // A conflict is surfaced by the card's dedicated "Merge conflicts" indicator +
  // Resolve button, so auto-merge bails WITHOUT a sticky error (mirroring the
  // review gate) — otherwise the card renders a redundant second
  // "PR has merge conflicts" line. It stays enabled to retry once rebased clean.
  it("does NOT merge a conflicting PR and sets no sticky error", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "conflicting"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(manager.get("s1")?.error).toBeUndefined();
    expect(manager.get("s1")?.enabled).toBe(true);
  });

  it("clears a stale error when a conflict appears", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);
    // Seed a stale error from a prior failed merge attempt.
    const state = manager.get("s1");
    if (state) state.error = { code: "no_branch_protection", message: "stale", settingsUrl: "u" };

    await manager.handleManaged("s1", makeSummary("none", "conflicting"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(manager.get("s1")?.error).toBeUndefined();
  });

  /**
   * The same hole the busy gate closes, in the window the busy gate cannot see.
   * `agentBusy` covers a turn's commit and the debounced push it arms — but a
   * push that is REJECTED leaves the branch behind for good, and by then the
   * session is idle and the checks GitHub reports are green for a commit the
   * session moved past. `services/auto-push-scheduler.ts` records two pull
   * requests that merged seven and two commits behind exactly this way.
   */
  describe("branch-sync gate", () => {
    const withSync = (state: BranchSyncState, ahead: number, behind: number) => ({
      ...makeSummary("success", "mergeable"),
      branchSync: { state, ahead, behind },
    });

    it.each([
      ["ahead", withSync("ahead", 2, 0)],
      ["diverged", withSync("diverged", 1, 1)],
    ])("does NOT merge when the local branch is %s of the remote", async (_state, summary) => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", summary, "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
      // A wait, not a misconfiguration — the arming stays live so the merge
      // happens on its own once the push lands.
      expect(manager.get("s1")?.error).toBeUndefined();
      expect(manager.get("s1")?.enabled).toBe(true);
      expect(manager.get("s1")?.completed).toBeUndefined();
    });

    it("merges when the remote is AHEAD of local — the PR is a superset, nothing is lost", async () => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", withSync("behind", 0, 3), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it("merges when the sync state is unknown — absence is never a verdict", async () => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      // No `branchSync` at all: no workspace, no tracking ref, HEAD elsewhere.
      // Blocking here would take auto-merge away from every session whose
      // workspace has been reclaimed.
      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

    /**
     * The per-tick reading is computed from this clone's own tracking ref, which
     * nothing updates when the remote branch moves in ANOTHER clone. Local HEAD
     * and the tracking ref then both sit at the old tip and read `in-sync`,
     * while GitHub holds a history this session has never had — so the loop asks
     * the remote once more before the irreversible call.
     */
    it("asks the remote before merging, and holds when the local reading was stale", async () => {
      const mergePullRequest = vi.fn().mockResolvedValue({ success: true, message: "merged" });
      const manager = new AutoMergeManager(
        { mergePullRequest } as unknown as GitHubAuthManager,
        vi.fn(),
        undefined,
        async () => ({ state: "diverged", ahead: 1, behind: 1 }),
      );
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", withSync("in-sync", 0, 0), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it("merges when the fresh read confirms the branch is current", async () => {
      const mergePullRequest = vi.fn().mockResolvedValue({ success: true, message: "merged" });
      const resolveSync = vi.fn().mockResolvedValue({ state: "in-sync", ahead: 0, behind: 0 });
      const manager = new AutoMergeManager(
        { mergePullRequest } as unknown as GitHubAuthManager,
        vi.fn(),
        undefined,
        resolveSync,
      );
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", withSync("in-sync", 0, 0), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      // Read for the branch the pull request is on, not the session's record.
      expect(resolveSync).toHaveBeenCalledWith("s1", "feature");
    });

    it("still merges when the fresh read cannot be taken (it throws)", async () => {
      const mergePullRequest = vi.fn().mockResolvedValue({ success: true, message: "merged" });
      const manager = new AutoMergeManager(
        { mergePullRequest } as unknown as GitHubAuthManager,
        vi.fn(),
        undefined,
        async () => { throw new Error("remote unreachable"); },
      );
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", withSync("in-sync", 0, 0), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

    it("merges once the push lands, with no user action in between", async () => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", withSync("ahead", 1, 0), "o", "r");
      expect(mergePullRequest).not.toHaveBeenCalled();

      // The next poll reads the pushed branch as in sync — and the arming that
      // was held is still armed, so the merge happens by itself.
      await manager.handleManaged("s1", withSync("in-sync", 0, 0), "o", "r");
      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });
  });

  // docs/266 — the merge-while-busy hole. PR #2327 merged 4 minutes into a turn
  // that was applying reviewer feedback; auto-commit fires AFTER the turn, so
  // those edits landed on a branch whose PR was already closed and
  // `merged-push-guard` (correctly) refused to push them. CI never saw the fix.
  describe("busy gate", () => {
    it("does NOT merge a green, mergeable PR while the session's agent is busy", async () => {
      const { manager, mergePullRequest } = makeManagerWithRunner({ running: true, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
      // Like the review gate (docs/174): a normal transient wait, so no sticky
      // error and the arming stays live for the next poll tick.
      expect(manager.get("s1")?.error).toBeUndefined();
      expect(manager.get("s1")?.enabled).toBe(true);
      expect(manager.get("s1")?.completed).toBeUndefined();
    });

    // `agentBusy`, not bare `running`. The incident's own turn spent 8 minutes
    // inside a backgrounded reviewer consult, and the auto-push the commit arms
    // runs entirely after `running` clears — a `running` check merges in both
    // windows. Both are `running:false, agentBusy:true`.
    it("holds the merge when the turn has ended but the agent is still working", async () => {
      const { manager, mergePullRequest } = makeManagerWithRunner({ running: false, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    it("merges the same PR on a later tick once the session goes idle", async () => {
      const { manager, mergePullRequest, box } = makeManagerWithRunner({ running: true, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
      expect(mergePullRequest).not.toHaveBeenCalled();

      box.runner = { running: false, agentBusy: false };
      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
      expect(manager.get("s1")?.completed).toBe(true);
    });

    // The "skip wiring when runnerRegistry is absent" contract: a degraded setup
    // must not turn the gate into a merge that never happens.
    it("merges when no runner registry is wired at all", async () => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

    // A system flow (the rebase driver) runs with `running` false and is
    // excluded from the runner's own `agentBusy`, yet it rebases, commits and
    // FORCE-PUSHES the branch. Merging a branch mid-rewrite is the same class of
    // damage the gate exists to stop.
    it("holds the merge during a system turn (rebase / force-push)", async () => {
      const { manager, mergePullRequest } = makeManagerWithRunner({
        running: false,
        agentBusy: false,
        systemTurnInProgress: true,
      });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
    });

    // The latch is per WAIT, and an idle tick between two busy episodes ends
    // one. Without this, a single shared or never-cleared latch makes every
    // later hold silent, and the log stops being the record of why a merge did
    // not happen.
    it("logs the hold again on a second busy episode", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        // A merge that fails leaves the arming live and sets no `completed`, so
        // the loop keeps running — which is what lets one manager see two
        // separate busy episodes without a toggle in between (a toggle clears
        // the latch by itself, and would hide the very defect this pins).
        const box: { runner: { running: boolean; agentBusy: boolean } } = {
          runner: { running: true, agentBusy: true },
        };
        const manager = new AutoMergeManager(
          { mergePullRequest: vi.fn().mockResolvedValue({ success: false, message: "nope" }) } as unknown as GitHubAuthManager,
          vi.fn(),
          () => box.runner as unknown as SessionRunnerInterface,
        );
        manager.setEnabled("s1", true);
        manager.setManaged("s1", true);
        const holds = () => log.mock.calls.filter((c) => String(c[0]).includes("agent busy")).length;

        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
        expect(holds()).toBe(1);

        // An idle tick gets past the gate — that ends the wait.
        box.runner = { running: false, agentBusy: false };
        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

        // The next turn starts: a new wait, so a new record.
        box.runner = { running: true, agentBusy: true };
        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
        expect(holds()).toBe(2);
      } finally {
        log.mockRestore();
      }
    });

    it("merges when the session has no runner (container reclaimed, session gone)", async () => {
      const { manager, mergePullRequest } = makeManagerWithRunner(undefined);
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });
  });

  // The hold is logged once per wait, and a toggle ends the wait — otherwise a
  // disable → re-enable → busy sequence holds the merge with no record of it.
  it("logs the hold again after auto-merge is toggled off and back on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    try {
      const { manager } = makeManagerWithRunner({ running: true, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
      const holds = () => log.mock.calls.filter((c) => String(c[0]).includes("Holding merge")).length;
      expect(holds()).toBe(1);

      // Same wait, same session: still one record.
      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
      expect(holds()).toBe(1);

      manager.setEnabled("s1", false);
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);
      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(holds()).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  // docs/266 — `managed` alone can't be rendered: one reason is a repo
  // misconfiguration, the other is a normal wait.
  describe("managedReason", () => {
    it("defaults to native-unavailable so the pre-existing fallback is unchanged", () => {
      const { manager } = makeManager();
      manager.setManaged("s1", true, { settingsUrl: "u", reason: "Allow auto-merge is off" });

      expect(manager.get("s1")?.managedReason).toBe("native-unavailable");
    });

    it("records session-live without a settings URL or GitHub error", () => {
      const { manager } = makeManager();
      manager.setManaged("s1", true, { managedReason: "session-live" });

      const state = manager.get("s1");
      expect(state?.managed).toBe(true);
      expect(state?.managedReason).toBe("session-live");
      expect(state?.settingsUrl).toBeUndefined();
      expect(state?.reason).toBeUndefined();
    });

    it("clears the reason when auto-merge is turned off", () => {
      const { manager } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true, { managedReason: "session-live" });

      manager.setEnabled("s1", false);

      expect(manager.get("s1")?.managed).toBe(false);
      expect(manager.get("s1")?.managedReason).toBeUndefined();
    });
  });

  it("ignores PRs that are not managed+enabled", async () => {
    const { manager, mergePullRequest } = makeManager();
    // enabled but not managed → native auto-merge owns it, executor must skip.
    manager.setEnabled("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "mergeable"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});
