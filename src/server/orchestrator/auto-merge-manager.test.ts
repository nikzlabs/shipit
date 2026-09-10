import { describe, it, expect, vi } from "vitest";

import { AutoMergeManager } from "./auto-merge-manager.js";
import { logMergeObserved, resetMergeAttribution } from "./services/merge-attribution.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type {
  BranchSyncState,
  PrMergeableState,
  PrReviewDecision,
  PrStatusSummary,
} from "../shared/types/github-types.js";

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
    const state = manager.get("s1");
    expect(state?.enabled).toBe(true);
    expect(state?.completed).toBe(true);
    expect(state?.error).toBeUndefined();
  });

  it("keeps auto-merge owning the session after a successful merge and does not re-merge", async () => {
    const { manager, mergePullRequest, onChange } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(manager.get("s1")?.enabled).toBe(true);

    onChange.mockClear();
    await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

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

  it.each(["review_required", "changes_requested"] as const)(
    "does NOT merge when reviewDecision is %s, even with CI green",
    async (reviewDecision) => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable", reviewDecision), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
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
    const state = manager.get("s1");
    if (state) state.error = { code: "no_branch_protection", message: "stale", settingsUrl: "u" };

    await manager.handleManaged("s1", makeSummary("none", "conflicting"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(manager.get("s1")?.error).toBeUndefined();
  });

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

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

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

      await manager.handleManaged("s1", withSync("in-sync", 0, 0), "o", "r");
      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("busy gate", () => {
    it("does NOT merge a green, mergeable PR while the session's agent is busy", async () => {
      const { manager, mergePullRequest } = makeManagerWithRunner({ running: true, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(manager.get("s1")?.error).toBeUndefined();
      expect(manager.get("s1")?.enabled).toBe(true);
      expect(manager.get("s1")?.completed).toBeUndefined();
    });

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

    it("merges when no runner registry is wired at all", async () => {
      const { manager, mergePullRequest } = makeManager();
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

      expect(mergePullRequest).toHaveBeenCalledTimes(1);
    });

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

    it("logs the hold again on a second busy episode", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
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

        box.runner = { running: false, agentBusy: false };
        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

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

  it("logs the hold again after auto-merge is toggled off and back on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    try {
      const { manager } = makeManagerWithRunner({ running: true, agentBusy: true });
      manager.setEnabled("s1", true);
      manager.setManaged("s1", true);

      await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
      const holds = () => log.mock.calls.filter((c) => String(c[0]).includes("Holding merge")).length;
      expect(holds()).toBe(1);

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
    manager.setEnabled("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "mergeable"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  describe("the merge record", () => {
    it("names the session, the PR, the repo, the method and the managed reason", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        const { manager } = makeManager();
        manager.setEnabled("s1", true);
        manager.setManaged("s1", true, { managedReason: "session-live" });

        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

        const merged = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Merged PR #"));
        expect(merged).toEqual([
          "[auto-merge] Merged PR #42 (o/r) for s1 via managed merge (squash, reason=session-live)",
        ]);
        expect(merged[0]).toMatch(/Merged PR #\d+ \(\S+\/\S+\) for \S+ via /);
      } finally {
        log.mockRestore();
      }
    });

    it("silences the poller's observation of the merge it just performed", async () => {
      resetMergeAttribution();
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        const { manager } = makeManager();
        manager.setEnabled("s1", true);
        manager.setManaged("s1", true);

        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");
        logMergeObserved({ owner: "o", repo: "r", prNumber: 42, sessionId: "s1" });

        expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("no ShipIt path recorded")))
          .toEqual([]);
      } finally {
        log.mockRestore();
      }
    });

    it("records nothing when the merge fails", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
      try {
        const { manager } = makeManager({ success: false, message: "no" });
        manager.setEnabled("s1", true);
        manager.setManaged("s1", true);

        await manager.handleManaged("s1", makeSummary("success", "mergeable"), "o", "r");

        expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Merged PR #"))).toEqual([]);
      } finally {
        log.mockRestore();
      }
    });
  });
});
