import { describe, it, expect, vi } from "vitest";

import { AutoMergeManager } from "./auto-merge-manager.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { PrMergeableState, PrReviewDecision, PrStatusSummary } from "../shared/types/github-types.js";

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

describe("AutoMergeManager.handleManaged", () => {
  it("merges a no-checks PR (checks.state === 'none') and then disables auto-merge — regression", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "mergeable"), "o", "r");

    expect(mergePullRequest).toHaveBeenCalledTimes(1);
    expect(mergePullRequest).toHaveBeenCalledWith("o", "r", 42, "squash");
    // Merge succeeded — auto-merge is disabled so the poller stops driving it.
    const state = manager.get("s1");
    expect(state?.enabled).toBe(false);
    expect(state?.managed).toBe(false);
    expect(state?.error).toBeUndefined();
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
    expect(manager.get("s1")?.enabled).toBe(false);
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
    expect(manager.get("s1")?.enabled).toBe(false);
  });

  it("flags a conflict (does NOT merge) for a no-checks PR with conflicts", async () => {
    const { manager, mergePullRequest } = makeManager();
    manager.setEnabled("s1", true);
    manager.setManaged("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "conflicting"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(manager.get("s1")?.error?.message).toBe("PR has merge conflicts");
  });

  it("ignores PRs that are not managed+enabled", async () => {
    const { manager, mergePullRequest } = makeManager();
    // enabled but not managed → native auto-merge owns it, executor must skip.
    manager.setEnabled("s1", true);

    await manager.handleManaged("s1", makeSummary("none", "mergeable"), "o", "r");

    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});
