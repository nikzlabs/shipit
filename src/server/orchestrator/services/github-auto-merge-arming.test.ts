import { describe, it, expect, vi } from "vitest";
import { toggleAutoMerge, activatePendingAutoMergeForPr, mergePullRequest, updateMergeMethod } from "./github.js";
import type { GitManager } from "../../shared/git.js";
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
function makePoller(
  initial: PrStatusSummary,
  armed?: AutoMergeState,
  /** docs/266 — does the session have a live runner? Drives managed-vs-native arming. */
  opts: { liveRunner?: boolean } = {},
) {
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
      setMergeMethod: vi.fn((_sessionId: string, method: "squash" | "merge" | "rebase") => {
        if (autoMerge) autoMerge = { ...autoMerge, mergeMethod: method };
      }),
      hasLiveRunner: () => opts.liveRunner === true,
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

/**
 * docs/266 — GitHub native auto-merge merges inside GitHub, which cannot see a
 * ShipIt turn: that is how PR #2327 merged while its agent was still applying
 * reviewer feedback. So a PR whose session is live is never handed to native;
 * it stays on the ShipIt-managed loop, where the busy gate is enforceable.
 */
describe("arming while the session is live", () => {
  it("toggleAutoMerge keeps the merge managed instead of arming GitHub native", async () => {
    const p = makePoller(summary(), undefined, { liveRunner: true });
    const enableAutoMerge = vi.fn(async () => ({ success: true }));
    const githubAuth = { authenticated: true, enableAutoMerge } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(enableAutoMerge).not.toHaveBeenCalled();
    expect(p.setAutoMergeEnabled).toHaveBeenCalledWith("s1", true);
    expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", true, { managedReason: "session-live" });
    expect(result).toEqual({
      enabled: true,
      mergeMethod: "squash",
      managed: true,
      managedReason: "session-live",
    });
  });

  // The false-error trap: `managed` used to mean exactly "GitHub refused", and
  // it carries the settingsUrl/reason the card renders as a repo
  // misconfiguration tooltip. A deliberate managed arming must carry neither.
  it("does not report a live session as a repository misconfiguration", async () => {
    const p = makePoller(summary(), undefined, { liveRunner: true });
    const githubAuth = {
      authenticated: true,
      enableAutoMerge: vi.fn(async () => ({ success: true })),
    } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(result).not.toHaveProperty("reason");
    const managedCall = p.setAutoMergeManaged.mock.calls.at(-1);
    expect(managedCall?.[2]).toEqual({ managedReason: "session-live" });
    expect(managedCall?.[2]).not.toHaveProperty("settingsUrl");
  });

  // The GitHub-refused fallback keeps its meaning — and now says so explicitly,
  // so the client can tell the two managed states apart.
  it("still reports native-unavailable when GitHub refuses on a quiet session", async () => {
    const p = makePoller(summary());
    const githubAuth = {
      authenticated: true,
      enableAutoMerge: vi.fn(async () => ({ success: false, message: "Allow auto-merge is turned off" })),
    } as unknown as GitHubAuthManager;

    const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

    expect(result).toEqual({
      enabled: true,
      mergeMethod: "squash",
      managed: true,
      managedReason: "native-unavailable",
      reason: "Allow auto-merge is turned off",
    });
  });

  /**
   * The same decision on a different signal. Native auto-merge cannot be called
   * back once armed: GitHub merges the branch as it currently has it the moment
   * the checks pass. So a session holding commits GitHub has never seen must not
   * hand the merge over — ShipIt's own loop can wait for the push to land, and
   * GitHub cannot.
   */
  describe("arming while the branch is not on GitHub yet", () => {
    const unsynced = (state: "ahead" | "diverged") =>
      summary({ branchSync: { state, ahead: 2, behind: state === "diverged" ? 1 : 0 } });

    it.each(["ahead", "diverged"] as const)(
      "toggleAutoMerge keeps a %s branch on the managed loop",
      async (state) => {
        const p = makePoller(unsynced(state));
        const enableAutoMerge = vi.fn(async () => ({ success: true }));
        const githubAuth = { authenticated: true, enableAutoMerge } as unknown as GitHubAuthManager;

        const result = await toggleAutoMerge(githubAuth, p.poller, "s1", true);

        expect(enableAutoMerge).not.toHaveBeenCalled();
        expect(result).toEqual({
          enabled: true,
          mergeMethod: "squash",
          managed: true,
          managedReason: "branch-unsynced",
        });
        // Not a misconfiguration: no settings link, no GitHub error text.
        expect(p.setAutoMergeManaged.mock.calls.at(-1)?.[2]).toEqual({ managedReason: "branch-unsynced" });
      },
    );

    it("arms GitHub native once the branch is in sync", async () => {
      const p = makePoller(summary({ branchSync: { state: "in-sync", ahead: 0, behind: 0 } }));
      const enableAutoMerge = vi.fn(async () => ({ success: true }));
      const githubAuth = { authenticated: true, enableAutoMerge } as unknown as GitHubAuthManager;

      await toggleAutoMerge(githubAuth, p.poller, "s1", true);

      expect(enableAutoMerge).toHaveBeenCalledTimes(1);
    });

    it("arms GitHub native when the sync state is unknown — absence is not a verdict", async () => {
      const p = makePoller(summary());
      const enableAutoMerge = vi.fn(async () => ({ success: true }));
      const githubAuth = { authenticated: true, enableAutoMerge } as unknown as GitHubAuthManager;

      await toggleAutoMerge(githubAuth, p.poller, "s1", true);

      expect(enableAutoMerge).toHaveBeenCalledTimes(1);
    });

    it("activatePendingAutoMergeForPr keeps a pre-armed unsynced PR managed too", async () => {
      const p = makePoller(unsynced("ahead"), { enabled: true, mergeMethod: "squash" });
      const enableAutoMerge = vi.fn(async () => ({ success: true }));
      const githubAuth = { enableAutoMerge } as unknown as GitHubAuthManager;

      await activatePendingAutoMergeForPr(githubAuth, p.poller, "s1", PR_URL, 42);

      expect(enableAutoMerge).not.toHaveBeenCalled();
      expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", true, { managedReason: "branch-unsynced" });
    });
  });

  it("activatePendingAutoMergeForPr arms managed for an agent-opened PR", async () => {
    // The common case: activation runs in the post-turn flow, whose runner is
    // still alive.
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash" }, { liveRunner: true });
    const enableAutoMerge = vi.fn(async () => ({ success: true }));
    const githubAuth = { enableAutoMerge } as unknown as GitHubAuthManager;

    await activatePendingAutoMergeForPr(githubAuth, p.poller, "s1", PR_URL, 42);

    expect(enableAutoMerge).not.toHaveBeenCalled();
    expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", true, { managedReason: "session-live" });
  });

  it("arms GitHub native when the session has no live runner", async () => {
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash" });
    const enableAutoMerge = vi.fn(async () => ({ success: true }));
    const githubAuth = { enableAutoMerge } as unknown as GitHubAuthManager;

    await activatePendingAutoMergeForPr(githubAuth, p.poller, "s1", PR_URL, 42);

    expect(enableAutoMerge).toHaveBeenCalledTimes(1);
    expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", false);
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

/**
 * docs/266 — the UI merge button's own arming path. "Merge" on a PR whose checks
 * are still running does not merge; it falls back to ARMING auto-merge, and that
 * fallback used to go straight to GitHub native. The session that clicked it is
 * quiet right now (the route 409s otherwise) but is one message away from a
 * turn, which is the state that merged PR #2327.
 */
describe("mergePullRequest — auto-merge fallback while checks are pending", () => {
  function makeGitAndAuth() {
    const git = {
      getCurrentBranch: vi.fn(async () => "shipit/feature"),
      getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    } as unknown as GitManager;
    const enableAutoMerge = vi.fn(async () => ({ success: true, message: "armed" }));
    const githubAuth = {
      authenticated: true,
      findPullRequest: vi.fn(async () => ({ number: 42, url: PR_URL })),
      mergePullRequest: vi.fn(async () => ({ success: false, message: "checks pending" })),
      getCheckStatus: vi.fn(async () => ({ state: "pending", total: 1, passed: 0, failed: 0, pending: 1 })),
      enableAutoMerge,
    } as unknown as GitHubAuthManager;
    return { git, githubAuth, enableAutoMerge };
  }

  it("keeps the arming managed for a live session instead of arming GitHub", async () => {
    const { git, githubAuth, enableAutoMerge } = makeGitAndAuth();

    const result = await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git", {
      preferManaged: true,
    });

    expect(enableAutoMerge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ autoMergeEnabled: true, managed: true });
    expect(result.message).toContain("this session finishes");
  });

  it("still arms GitHub native when no session runner is live", async () => {
    const { git, githubAuth, enableAutoMerge } = makeGitAndAuth();

    const result = await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git");

    expect(enableAutoMerge).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ autoMergeEnabled: true });
    expect(result.managed).toBeUndefined();
  });
});

/**
 * docs/266 — changing the merge method rewrites an arming, and the old code
 * rewrote it straight onto GitHub: `disableAutoMerge` + `enableAutoMerge`
 * whenever local state said enabled. For a managed arming there is nothing on
 * GitHub to re-point (the method is read from our state at merge time), and
 * arming native there would leave BOTH loops owning the same PR.
 */
describe("updateMergeMethod — does not hand a managed PR to GitHub", () => {
  function authStub() {
    return {
      disableAutoMerge: vi.fn(async () => ({ success: true })),
      enableAutoMerge: vi.fn(async () => ({ success: true })),
    } as unknown as GitHubAuthManager & {
      disableAutoMerge: ReturnType<typeof vi.fn>;
      enableAutoMerge: ReturnType<typeof vi.fn>;
    };
  }

  it("touches GitHub not at all for a ShipIt-managed arming", async () => {
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash", managed: true, managedReason: "session-live" }, { liveRunner: true });
    const githubAuth = authStub();

    const result = await updateMergeMethod(githubAuth, p.poller, "s1", "rebase");

    expect(githubAuth.enableAutoMerge).not.toHaveBeenCalled();
    expect(githubAuth.disableAutoMerge).not.toHaveBeenCalled();
    expect(result).toEqual({ mergeMethod: "rebase" });
  });

  // Armed native while the session was quiet, then the session came alive.
  // Re-arming native is exactly the hand-off req 4 forbids.
  it("takes ownership instead of re-arming native when the session is now live", async () => {
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash" }, { liveRunner: true });
    const githubAuth = authStub();

    await updateMergeMethod(githubAuth, p.poller, "s1", "rebase");

    expect(githubAuth.disableAutoMerge).toHaveBeenCalledTimes(1);
    expect(githubAuth.enableAutoMerge).not.toHaveBeenCalled();
    expect(p.setAutoMergeManaged).toHaveBeenCalledWith("s1", true, { managedReason: "session-live" });
  });

  it("still re-points GitHub native for a quiet session", async () => {
    const p = makePoller(summary(), { enabled: true, mergeMethod: "squash" });
    const githubAuth = authStub();

    await updateMergeMethod(githubAuth, p.poller, "s1", "rebase");

    expect(githubAuth.disableAutoMerge).toHaveBeenCalledTimes(1);
    expect(githubAuth.enableAutoMerge).toHaveBeenCalledTimes(1);
  });
});
