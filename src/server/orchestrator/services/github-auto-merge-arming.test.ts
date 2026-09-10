import { describe, it, expect, vi } from "vitest";
import { toggleAutoMerge, activatePendingAutoMergeForPr, mergePullRequest, updateMergeMethod } from "./github.js";
import { resetMergeAttribution } from "./merge-attribution.js";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AutoMergeState, PrStatusSummary } from "../../shared/types/github-types.js";

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

function makePoller(
  initial: PrStatusSummary,
  armed?: AutoMergeState,
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
    observeMerge: () => {
      status = summary({ prState: "merged" });
      autoMerge = undefined;
    },
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
      sessionId: "s1",
    });

    expect(enableAutoMerge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ autoMergeEnabled: true, managed: true });
    expect(result.message).toContain("this session finishes");
  });

  it("still arms GitHub native when no session runner is live", async () => {
    const { git, githubAuth, enableAutoMerge } = makeGitAndAuth();

    const result = await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git", {
      sessionId: "s1",
    });

    expect(enableAutoMerge).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ autoMergeEnabled: true });
    expect(result.managed).toBeUndefined();
  });
});

describe("mergePullRequest — the merge record", () => {
  function makeGitAndAuth(mergeResult: { success: boolean; message: string }) {
    const git = {
      getCurrentBranch: vi.fn(async () => "shipit/feature"),
      getRemotes: vi.fn(async () => [{ name: "origin", url: "https://github.com/o/r.git" }]),
    } as unknown as GitManager;
    const githubAuth = {
      authenticated: true,
      findPullRequest: vi.fn(async () => ({ number: 42, url: PR_URL })),
      mergePullRequest: vi.fn(async () => mergeResult),
      getCheckStatus: vi.fn(async () => ({ state: "pending", total: 1, passed: 0, failed: 0, pending: 1 })),
      enableAutoMerge: vi.fn(async () => ({ success: true, message: "armed" })),
    } as unknown as GitHubAuthManager;
    return { git, githubAuth };
  }

  function mergeLines(log: { mock: { calls: unknown[][] } }): string[] {
    return log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Merged PR #"));
  }

  it("names the session, the PR, the repo and the method", async () => {
    resetMergeAttribution();
    const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    try {
      const { git, githubAuth } = makeGitAndAuth({ success: true, message: "merged" });

      await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git", { sessionId: "s1" });

      expect(mergeLines(log)).toEqual([
        "[pr] Merged PR #42 (o/r) for s1 via the ShipIt merge button (squash)",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("records nothing when the click only arms auto-merge", async () => {
    resetMergeAttribution();
    const log = vi.spyOn(console, "log").mockImplementation(() => { /* silence */ });
    try {
      const { git, githubAuth } = makeGitAndAuth({ success: false, message: "checks pending" });

      await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git", { sessionId: "s1" });
      await mergePullRequest(git, githubAuth, "squash", "https://github.com/o/r.git", {
        sessionId: "s1", preferManaged: true,
      });

      expect(mergeLines(log)).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

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
