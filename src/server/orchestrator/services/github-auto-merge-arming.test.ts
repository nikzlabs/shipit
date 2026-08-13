import { describe, it, expect, vi } from "vitest";
import { toggleAutoMerge, activatePendingAutoMergeForPr } from "./github.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AutoMergeState, PrStatusSummary } from "../../shared/types/github-types.js";

/**
 * docs/077 — an auto-merge arming belongs to ONE pull request, and the poller
 * drops it the moment that PR goes terminal. Both writers here land AFTER an
 * awaited GitHub round-trip, so the merge can be observed inside that window: an
 * unconditional write then RE-CREATES the arming for a PR that no longer exists.
 * That strands the toggle ON in the UI and — worse — a lingering `enabled` is
 * what `activatePendingAutoMergeForPr` reads as a deliberate pre-arm, so the
 * session's NEXT pull request would merge without the user ever asking.
 */

const PR_URL = "https://github.com/o/r/pull/42";

function summary(over: Partial<PrStatusSummary> = {}): PrStatusSummary {
  return {
    sessionId: "s1",
    prNumber: 42,
    prUrl: PR_URL,
    prTitle: "t",
    prState: "open",
    baseBranch: "main",
    headBranch: "h",
    insertions: 0,
    deletions: 0,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "mergeable",
    reviewDecision: "none",
    autoMergeEnabled: false,
    ...over,
  } as PrStatusSummary;
}

/**
 * A poller stub whose last-known summary can flip mid-call, standing in for the
 * merge landing while GitHub answers.
 */
function makePoller(initial: PrStatusSummary, armed?: AutoMergeState) {
  let status: PrStatusSummary | undefined = initial;
  let autoMerge: AutoMergeState | undefined = armed;
  const setAutoMergeEnabled = vi.fn((_sessionId: string, enabled: boolean) => {
    autoMerge = { ...(autoMerge ?? { mergeMethod: "squash" as const }), enabled };
    return autoMerge;
  });
  const setAutoMergeManaged = vi.fn();
  return {
    poller: {
      getStatus: () => status,
      getAutoMergeState: () => autoMerge,
      setAutoMergeEnabled,
      setAutoMergeManaged,
    } as unknown as PrStatusPoller,
    setAutoMergeEnabled,
    setAutoMergeManaged,
    /** The poller observes the terminal PR and retires the arming (docs/077). */
    observeMerge: () => {
      status = summary({ prState: "merged" });
      autoMerge = undefined;
    },
    /** The poller has moved on to a different PR entirely. */
    setStatus: (next: PrStatusSummary) => { status = next; },
  };
}

describe("toggleAutoMerge — PR merges during the GitHub round-trip", () => {
  it("does not re-arm a PR that merged while auto-merge was being enabled", async () => {
    const p = makePoller(summary());
    const githubAuth = {
      authenticated: true,
      enableAutoMerge: vi.fn(async () => {
        p.observeMerge();
        return { success: true };
      }),
    } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(p.setAutoMergeEnabled).not.toHaveBeenCalled();
    // Reported truthfully: nothing is armed, so the client converges too.
    expect(result).toEqual({ enabled: false, mergeMethod: "squash" });
  });

  it("does not fall back to managed auto-merge on a PR that merged mid-call", async () => {
    const p = makePoller(summary());
    const githubAuth = {
      authenticated: true,
      enableAutoMerge: vi.fn(async () => {
        p.observeMerge();
        return { success: false, message: "Allow auto-merge is turned off" };
      }),
    } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(p.setAutoMergeManaged).not.toHaveBeenCalled();
    expect(p.setAutoMergeEnabled).not.toHaveBeenCalled();
    expect(result).toEqual({ enabled: false, mergeMethod: "squash" });
  });

  it("arms normally when the PR is still open", async () => {
    const p = makePoller(summary());
    const githubAuth = {
      authenticated: true,
      enableAutoMerge: vi.fn(async () => ({ success: true })),
    } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(p.setAutoMergeEnabled).toHaveBeenCalledWith("s1", true);
    expect(result).toEqual({ enabled: true, mergeMethod: "squash" });
  });
});

describe("activatePendingAutoMergeForPr — PR merges during the GitHub round-trip", () => {
  it("does not re-create the arming for a PR that merged mid-activation", async () => {
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash" });
    const githubAuth = {
      enableAutoMerge: vi.fn(async () => {
        p.observeMerge();
        return { success: true };
      }),
    } as unknown as GitHubAuthManager;

    await activatePendingAutoMergeForPr(githubAuth, p.poller, "s1", PR_URL, 42);

    expect(p.setAutoMergeEnabled).not.toHaveBeenCalled();
    expect(p.setAutoMergeManaged).not.toHaveBeenCalled();
  });

  // The guard compares PR NUMBERS on purpose. Right after `gh pr create` on a
  // chained session the poller still holds the PREVIOUS, just-merged PR (see
  // `self-merge-watch.test.ts`); a bare "is the status terminal?" check would
  // refuse to arm the brand-new PR.
  it("still arms the new PR while the poller holds a terminal OLDER one", async () => {
    const p = makePoller(
      summary({ prNumber: 41, prState: "merged" }),
      { enabled: true, mergeMethod: "squash" },
    );
    const githubAuth = {
      enableAutoMerge: vi.fn(async () => ({ success: true })),
    } as unknown as GitHubAuthManager;

    await activatePendingAutoMergeForPr(githubAuth, p.poller, "s1", PR_URL, 42);

    expect(p.setAutoMergeEnabled).toHaveBeenCalledWith("s1", true);
    expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", false);
  });
});
