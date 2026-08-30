import { describe, it, expect, vi } from "vitest";
import {
  measurePushDivergence,
  formatDivergedPushNotice,
  MAX_NAMED_COMMITS,
  type PushDivergenceGit,
  type PushDivergence,
} from "./push-divergence.js";

/**
 * The 2026-08-30 incident, pinned: a session's pull request merged, the docs/218
 * pre-turn auto-reset moved the branch to the fresh base and healed the remote,
 * a later turn pushed one commit that belonged to no pull request — and then an
 * agent-side rebase dropped that commit LOCALLY. From then on every auto-push
 * was rejected, and the notice told the user their commit was safe locally
 * (there was no local commit) while pointing them at the one recovery that would
 * have deleted the commit from the only place it still existed.
 *
 * So these assert the two things the old notice could not do: it MEASURES the
 * shape, and it names the ONE recovery that fits it. The shapes are built from
 * counts alone — no network, no repository.
 */

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

/** A measured shape, straight to the formatter. */
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
  it("fetches the branch before counting, so a stale tracking ref cannot decide the advice", async () => {
    // The counts pick the recovery, and one of the two recoveries destroys the
    // remote's commits. Reading a tracking ref this clone last wrote itself
    // would report "nothing only on the remote" for a remote that moved
    // elsewhere — which is a recommendation to force-push over someone's work.
    const git = fakeGit({ aheadBehind: vi.fn(async () => ({ ahead: 2, behind: 0 })) });
    const measured = await measurePushDivergence(git);

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
    // A failed merge-base must not invent an "unrelated histories" claim — that
    // reading only ever ADDS a warning, so it fails toward the ordinary shape.
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
    // The recovery the old notice emphasised. `reset-to-base --force` resets to
    // the base and force-pushes the heal, so here it deletes the one commit that
    // exists anywhere — it must not be named as the remedy for this shape.
    expect(notice).not.toContain("reset-to-base");
  });

  it("does not claim a local commit is waiting, because none is", () => {
    // The old notice opened with "The commit is safe in this session's local
    // history" on every shape. In this one there was no local commit at all.
    expect(notice).not.toContain("would merge WITHOUT");
  });
});

describe("formatDivergedPushNotice — only this branch is ahead", () => {
  const notice = formatDivergedPushNotice(shape({ ahead: 2, behind: 0 }));

  it("says nothing on the remote is at risk and names the force-push", () => {
    expect(notice).toContain("nothing on GitHub is at risk");
    expect(notice).toContain("git push --force-with-lease origin shipit/feature");
  });

  it("warns that a pull request would merge without the unpushed commits", () => {
    expect(notice).toContain("would merge WITHOUT the 2 commits");
  });

  it("does not recommend a pull, which would drag the replaced history back", () => {
    expect(notice).not.toContain("git pull --rebase");
  });

  it("says who can still run the force-push when the merged-branch hook blocks the agent", () => {
    // planning#267 arms `SHIPIT_GUARD_DESTRUCTIVE_GIT=1` on a merged branch, and
    // `block-branch-ops.mjs` refuses a hand-rolled force-push outright. A remedy
    // the agent is refused when it runs it is the same dead end in a friendlier
    // voice — but SUBSTITUTING `reset-to-base` would be a lie, because that
    // command discards this branch's history instead of publishing it. So the
    // command stays, with a note about who may run it and what the brokered
    // alternative actually does.
    const blocked = formatDivergedPushNotice(shape({ ahead: 2, behind: 0 }), { forcePushBlocked: true });
    expect(blocked).toContain("git push --force-with-lease origin shipit/feature");
    expect(blocked).toContain("the user can run it from the terminal");
    expect(blocked).toContain('shipit branch reset-to-base --force --reason "<why>"');
    expect(blocked).toContain("discards this branch's commits rather than publishing them");
  });

  it("does not carry the blocked note when the hook is not armed", () => {
    expect(formatDivergedPushNotice(shape({ ahead: 2, behind: 0 }))).not.toContain("reset-to-base");
  });
});

describe("formatDivergedPushNotice — both sides carry work", () => {
  const notice = formatDivergedPushNotice(shape({
    ahead: 3,
    behind: 2,
    remoteOnly: [{ sha: "aaa1111", subject: "one" }, { sha: "bbb2222", subject: "two" }],
  }));

  it("leads with the non-destructive recovery", () => {
    expect(notice).toContain("Recovery: `git pull --rebase origin shipit/feature`");
  });

  it("offers the force-push only with its condition and its cost", () => {
    expect(notice).toContain("Only if the remote's 2 commits");
    expect(notice).toContain("discards them permanently");
    expect(notice).toContain("aaa1111 one");
  });
});

describe("formatDivergedPushNotice — the shapes with no safe default", () => {
  it("refuses to pick a side when the histories are unrelated", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 1, behind: 1, sharedBase: false }));
    expect(notice).toContain("share no commit at all");
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
    // The command that answers the question, rather than a guess at the answer.
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

  it("labels counts taken against an unrefreshed remote view", () => {
    const notice = formatDivergedPushNotice(shape({ ahead: 1, behind: 0, refreshed: false }));
    expect(notice).toContain("last-known remote state");
    expect(notice).toContain("git fetch origin shipit/feature");
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

  it("states that ShipIt will not force the divergence open by itself", () => {
    // The rule is correct and stays; what this fix changed is the report around
    // it. Every shape has to say the branch on GitHub is frozen until resolved,
    // or the user reads a rejection as a transient blip.
    for (const d of every) {
      expect(formatDivergedPushNotice(d)).toContain("ShipIt never force-pushes on its own");
      expect(formatDivergedPushNotice(d)).toContain("every later auto-push is rejected");
    }
  });

  it("renders as plain text — a notice is not markdown", () => {
    for (const d of every) expect(formatDivergedPushNotice(d)).not.toContain("**");
  });
});
