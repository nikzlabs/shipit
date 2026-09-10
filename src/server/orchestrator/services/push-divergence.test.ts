import { describe, it, expect, vi } from "vitest";
import {
  measurePushDivergence,
  formatDivergedPushNotice,
  baseRebaseIsSafe,
  MAX_NAMED_COMMITS,
  FETCH_TIMEOUT_MS,
  type PushDivergenceGit,
  type PushDivergence,
} from "./push-divergence.js";

function fakeGit(overrides: Partial<PushDivergenceGit> = {}): PushDivergenceGit {
  return {
    currentBranchOrNull: vi.fn(async () => "shipit/feature"),
    fetchBranch: vi.fn(async () => {}),
    aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
    mergeBase: vi.fn(async () => "abc1234"),
    commitSubjects: vi.fn(async () => []),
    ...overrides,
  };
}

function shape(over: Partial<Extract<PushDivergence, { measured: true }>> = {}) {
  return {
    measured: true as const,
    branch: "shipit/feature",
    remote: "origin",
    ahead: 0,
    behind: 0,
    sharedBase: true,
    remoteOnly: [],
    remoteOnlyTruncated: false,
    refreshed: true,
    ...over,
  };
}

describe("measurePushDivergence", () => {
  it("fetches the branch BEFORE counting, so a stale tracking ref cannot decide the advice", async () => {
    const calls: string[] = [];
    const git = fakeGit({
      fetchBranch: vi.fn(async () => { calls.push("fetch"); }),
      aheadBehind: vi.fn(async () => { calls.push("count"); return { ahead: 2, behind: 0 }; }),
    });
    const measured = await measurePushDivergence(git);

    expect(calls).toEqual(["fetch", "count"]);
    expect(git.fetchBranch).toHaveBeenCalledWith("origin", "shipit/feature");
    expect(measured).toMatchObject({ measured: true, ahead: 2, behind: 0, refreshed: true });
  });

  it("still measures when the fetch fails, and records that the counts are last-known", async () => {
    const git = fakeGit({
      fetchBranch: vi.fn(async () => { throw new Error("remote unreachable"); }),
      aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 1 })),
    });
    const measured = await measurePushDivergence(git);

    expect(measured).toMatchObject({ measured: true, behind: 1, refreshed: false });
  });

  it("gives up on a fetch that never returns, rather than hanging the notice", async () => {
    vi.useFakeTimers();
    try {
      const git = fakeGit({
        fetchBranch: vi.fn(() => new Promise<void>(() => { /* never settles */ })),
        aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 2 })),
      });
      const measuring = measurePushDivergence(git);
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1000);

      expect(await measuring).toMatchObject({ measured: true, behind: 2, refreshed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the commits that exist only on the remote", async () => {
    const git = fakeGit({
      aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 1 })),
      commitSubjects: vi.fn(async () => [{ sha: "d4f3ff4", subject: "Add the exporter" }]),
    });
    const measured = await measurePushDivergence(git);

    expect(git.commitSubjects).toHaveBeenCalledWith("HEAD..refs/remotes/origin/shipit/feature", MAX_NAMED_COMMITS);
    expect(measured).toMatchObject({
      remoteOnly: [{ sha: "d4f3ff4", subject: "Add the exporter" }],
      remoteOnlyTruncated: false,
    });
  });

  it("marks the list truncated when the remote is further ahead than it names", async () => {
    const git = fakeGit({
      aheadBehind: vi.fn(async () => ({ ahead: 0, behind: 9 })),
      commitSubjects: vi.fn(async () => Array.from({ length: MAX_NAMED_COMMITS }, (_, i) => ({
        sha: `c${i}`, subject: `commit ${i}`,
      }))),
    });
    expect(await measurePushDivergence(git)).toMatchObject({ remoteOnlyTruncated: true });
  });

  it("does not list remote commits when there are none", async () => {
    const git = fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 3, behind: 0 })) });
    await measurePushDivergence(git);
    expect(git.commitSubjects).not.toHaveBeenCalled();
  });

  it("reports unmeasured rather than guessing when the histories cannot be compared", async () => {
    const git = fakeGit({ aheadBehind: vi.fn(async () => null) });
    expect(await measurePushDivergence(git)).toMatchObject({
      measured: false,
      branch: "shipit/feature",
    });
  });

  it("reports unmeasured on a detached HEAD", async () => {
    const git = fakeGit({ currentBranchOrNull: vi.fn(async () => null) });
    expect(await measurePushDivergence(git)).toMatchObject({ measured: false, branch: null });
  });

  it("never throws, whatever the git reads do", async () => {
    const git = fakeGit({
      currentBranchOrNull: vi.fn(async () => { throw new Error("unreadable .git"); }),
    });
    await expect(measurePushDivergence(git)).resolves.toMatchObject({ measured: false });
  });

  it("survives a merge-base or log read that throws", async () => {
    const git = fakeGit({
      aheadBehind: vi.fn(async () => ({ ahead: 1, behind: 1 })),
      mergeBase: vi.fn(async () => { throw new Error("boom"); }),
      commitSubjects: vi.fn(async () => { throw new Error("boom"); }),
    });
    expect(await measurePushDivergence(git)).toMatchObject({
      measured: true, sharedBase: true, remoteOnly: [],
    });
  });
});

describe("formatDivergedPushNotice — only the remote is ahead (the 2026-08-30 shape)", () => {
  const notice = formatDivergedPushNotice(shape({
    ahead: 0,
    behind: 1,
    remoteOnly: [{ sha: "d4f3ff4", subject: "Add the exporter" }],
  }));

  it("states the measurement, both sides", () => {
    expect(notice).toContain("1 commit only on the remote");
    expect(notice).toContain("0 commits only in this session");
  });

  it("names the at-risk commit rather than only counting it", () => {
    expect(notice).toContain("d4f3ff4 Add the exporter");
  });

  it("recommends the pull, which is the only recovery that keeps the commit", () => {
    expect(notice).toContain("git pull --rebase origin shipit/feature");
  });

  it("warns against the force-push instead of offering it", () => {
    expect(notice).toContain("Do NOT force-push");
    expect(notice).not.toContain("git push --force-with-lease");
    expect(notice).not.toContain("reset-to-base");
  });

  it("does not claim a local commit is waiting, because none is", () => {
    expect(notice).not.toContain("would merge WITHOUT");
  });
});

describe("formatDivergedPushNotice — nothing exists only on the remote", () => {
  const notice = formatDivergedPushNotice(shape({ ahead: 2, behind: 0 }));

  it("says the counts do not explain the rejection", () => {
    expect(notice).toContain("do not explain the rejection");
    expect(notice).toContain("should have fast-forwarded");
  });

  it("names no recovery, and no force-push", () => {
    expect(notice).not.toContain("Recovery:");
    expect(notice).not.toContain("--force-with-lease");
    expect(notice).toContain("Do not force-push on the strength of these counts");
  });

  it("still says the remote does not carry this session's commits", () => {
    expect(notice).toContain("does not contain 2 commits from this session");
  });
});

describe("formatDivergedPushNotice — both sides carry work (the rewritten branch)", () => {
  const both = shape({
    ahead: 3,
    behind: 2,
    remoteOnly: [{ sha: "aaa1111", subject: "one" }, { sha: "bbb2222", subject: "two" }],
  });
  const notice = formatDivergedPushNotice(both);

  it("leads with the non-destructive recovery", () => {
    expect(notice).toContain("Recovery: `git pull --rebase origin shipit/feature`");
  });

  it("offers the force-push only with its condition and its cost", () => {
    expect(notice).toContain("Only if the remote's 2 commits");
    expect(notice).toContain("discards them permanently");
    expect(notice).toContain("aaa1111 one");
  });

  it("states what the remote is missing without over-claiming about the pull request", () => {
    expect(notice).toContain("does not contain 3 commits from this session");
    expect(notice).not.toContain("would merge WITHOUT");
  });

  it("says who can still run the force-push when the merged-branch hook blocks the agent", () => {
    const blocked = formatDivergedPushNotice(both, { forcePushBlocked: true });
    expect(blocked).toContain("git push --force-with-lease origin shipit/feature");
    expect(blocked).toContain("the user can run it from the terminal");
    expect(blocked).toContain('shipit branch reset-to-base --force --reason "<why>"');
    expect(blocked).toContain("discards this branch's commits rather than publishing them");
  });

  it("does not carry the blocked note when the hook is not armed", () => {
    expect(notice).not.toContain("reset-to-base");
  });
});

describe("baseRebaseIsSafe — may the client's one-click rebase banner be armed?", () => {
  it("allows it for the rewritten-branch shape, which the force-push repairs", () => {
    expect(baseRebaseIsSafe(shape({ ahead: 3, behind: 2 }))).toBe(true);
  });

  it("allows it when nothing exists only on the remote — a force-push can discard nothing", () => {
    expect(baseRebaseIsSafe(shape({ ahead: 1, behind: 0 }))).toBe(true);
  });

  it("refuses the 2026-08-30 shape, where the remote holds the only copy", () => {
    expect(baseRebaseIsSafe(shape({ ahead: 0, behind: 1 }))).toBe(false);
  });

  it("refuses unrelated histories", () => {
    expect(baseRebaseIsSafe(shape({ ahead: 2, behind: 2, sharedBase: false }))).toBe(false);
  });

  it("fails closed on anything unmeasured", () => {
    expect(baseRebaseIsSafe({
      measured: false, branch: "shipit/feature", remote: "origin", reason: "unreadable",
    })).toBe(false);
  });
});

describe("formatDivergedPushNotice — the shapes with no safe default", () => {
  it("refuses to pick a side when the histories are unrelated", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 1, behind: 1, sharedBase: false }));
    expect(notice).toContain("no commit common to the two histories");
    expect(notice).toContain("decide with the user");
    expect(notice).not.toContain("Recovery:");
  });

  it("names no recovery at all when the shape could not be measured", () => {
    const notice = formatDivergedPushNotice({
      measured: false,
      branch: "shipit/feature",
      remote: "origin",
      reason: "this clone has no origin/shipit/feature to compare against",
    });
    expect(notice).toContain("could not measure");
    expect(notice).toContain("this clone has no origin/shipit/feature");
    expect(notice).toContain("git rev-list --left-right --count HEAD...origin/shipit/feature");
    expect(notice).not.toContain("Recovery:");
    expect(notice).not.toContain("--force-with-lease");
  });

  it("degrades to a placeholder branch rather than printing undefined", () => {
    const notice = formatDivergedPushNotice({
      measured: false, branch: null, remote: "origin", reason: "detached HEAD",
    });
    expect(notice).toContain("origin/<branch>");
    expect(notice).not.toContain("undefined");
  });

  it("says the counts do not explain the rejection when neither side is ahead", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 0, behind: 0 }));
    expect(notice).toContain("do not explain the rejection");
    expect(notice).not.toContain("Recovery:");
  });

  it("names no recovery at all when the counts could not be refreshed", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 1, behind: 1, refreshed: false }));
    expect(notice).toContain("last-known remote state");
    expect(notice).toContain("git fetch origin shipit/feature");
    expect(notice).not.toContain("Recovery:");
    expect(notice).not.toContain("--force-with-lease");
  });

  it("allows that an unrelated-histories reading may itself be a failed comparison", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 1, behind: 1, sharedBase: false }));
    expect(notice).toContain("or the comparison itself failed");
  });
});

describe("formatDivergedPushNotice — what every shape says", () => {
  const every: PushDivergence[] = [
    shape({ ahead: 0, behind: 1 }),
    shape({ ahead: 1, behind: 0 }),
    shape({ ahead: 1, behind: 1 }),
    shape({ ahead: 0, behind: 0 }),
    shape({ ahead: 1, behind: 1, sharedBase: false }),
    { measured: false, branch: "shipit/feature", remote: "origin", reason: "unreadable" },
  ];

  it("opens by saying the push did not happen, and why", () => {
    for (const d of every) {
      expect(formatDivergedPushNotice(d)).toContain("Not pushed");
      expect(formatDivergedPushNotice(d)).toContain("non-fast-forward");
    }
  });

  it("states that the AUTO-push will not force the divergence open", () => {
    for (const d of every) {
      const notice = formatDivergedPushNotice(d);
      expect(notice).toContain("The post-turn auto-push never forces a divergence open");
      expect(notice).not.toContain("ShipIt never force-pushes");
      expect(notice).toContain("every later auto-push is rejected");
    }
  });

  it("renders as plain text — a notice is not markdown", () => {
    for (const d of every) expect(formatDivergedPushNotice(d)).not.toContain("**");
  });
});
