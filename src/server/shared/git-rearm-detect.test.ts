import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * docs/202 — detection matrix for `advancedBeyondMergedBase`, the squash-safe
 * "has this merged branch been rebased onto its base and gained new work?" check.
 *
 * Matrix: {squash, regular} merge × {rebased, not-rebased} × {new work, clean}.
 * The load-bearing case is squash + rebased + clean → false (no false positive
 * the instant after a squash merge), and squash + rebased + new-work → true.
 */
describe("GitManager.advancedBeyondMergedBase (docs/202 re-arm detection)", () => {
  let root: string;
  let bareDir: string;
  let maintainerDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-rearm-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    maintainerDir = path.join(root, "maintainer");
    workDir = path.join(root, "work");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(maintainerDir);
    fs.mkdirSync(workDir);

    // Bare remote with a seeded main branch.
    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "base.txt"), "base v1\n");
    run("git add -A && git commit -m 'base'", maintainerDir);
    run("git push origin main", maintainerDir);

    // Session clone with a feature branch carrying one commit (the "merged" work).
    run(`git clone ${bareDir} .`, workDir);
    run("git checkout -b feature", workDir);
    fs.writeFileSync(path.join(workDir, "feature.txt"), "feature v1\n");
    run("git add -A && git commit -m 'feature work'", workDir);
    run("git push origin feature", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Land the feature onto main on the remote, then fetch it into the work clone. */
  function mergeIntoMain(kind: "regular" | "squash"): void {
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    if (kind === "regular") {
      // --no-ff so the feature commits become ancestors of main with a merge commit.
      run("git merge --no-ff -m 'Merge feature' origin/feature", maintainerDir);
    } else {
      // Squash: main gets ONE new commit with the feature's tree; the feature's
      // own commits never enter main's history.
      run("git merge --squash origin/feature", maintainerDir);
      run("git commit -m 'Squash-merge feature'", maintainerDir);
    }
    run("git push origin main", maintainerDir);
    run("git fetch origin", workDir);
  }

  function setup(opts: { merge: "regular" | "squash"; rebase: boolean; newWork: boolean }): GitManager {
    mergeIntoMain(opts.merge);
    if (opts.rebase) {
      // Rebasing the (now redundant) feature commits onto the advanced base drops
      // the already-merged content; what remains is genuinely-new work, if any.
      run("git rebase origin/main", workDir);
    }
    if (opts.newWork) {
      fs.writeFileSync(path.join(workDir, "new-work.txt"), "brand new\n");
      run("git add -A && git commit -m 'new work after merge'", workDir);
    }
    return new GitManager(workDir);
  }

  it("squash + rebased + clean → false (no false positive after a squash merge)", async () => {
    const git = setup({ merge: "squash", rebase: true, newWork: false });
    expect(await git.advancedBeyondMergedBase("main")).toBe(false);
  });

  it("squash + rebased + new work → true", async () => {
    const git = setup({ merge: "squash", rebase: true, newWork: true });
    expect(await git.advancedBeyondMergedBase("main")).toBe(true);
  });

  it("regular + rebased + clean → false", async () => {
    const git = setup({ merge: "regular", rebase: true, newWork: false });
    expect(await git.advancedBeyondMergedBase("main")).toBe(false);
  });

  it("regular + rebased + new work → true", async () => {
    const git = setup({ merge: "regular", rebase: true, newWork: true });
    expect(await git.advancedBeyondMergedBase("main")).toBe(true);
  });

  it("squash + not-rebased + new work → false (conservative until rebased)", async () => {
    const git = setup({ merge: "squash", rebase: false, newWork: true });
    expect(await git.advancedBeyondMergedBase("main")).toBe(false);
  });

  it("regular + not-rebased + new work → false (conservative until rebased)", async () => {
    const git = setup({ merge: "regular", rebase: false, newWork: true });
    expect(await git.advancedBeyondMergedBase("main")).toBe(false);
  });

  it("returns false when origin/<base> is missing (fail safe)", async () => {
    const git = setup({ merge: "regular", rebase: true, newWork: true });
    expect(await git.advancedBeyondMergedBase("does-not-exist")).toBe(false);
  });

  it("diffStatTwoDot reports HEAD-side changes (non-empty with new work)", async () => {
    const git = setup({ merge: "regular", rebase: true, newWork: true });
    const stat = await git.diffStatTwoDot("origin/main");
    expect(stat.files).toBeGreaterThan(0);
  });

  it("diffStatTwoDot is empty for a rebased branch with no new work", async () => {
    const git = setup({ merge: "regular", rebase: true, newWork: false });
    expect((await git.diffStatTwoDot("origin/main")).files).toBe(0);
  });

  /**
   * docs/216 — `headIsAtBase` drives the reset-to-clean-base re-arm: a MERGED
   * session whose branch was `git reset --hard origin/main`'d sits exactly at
   * the base tip (no commits of its own) and should drop its stale merged card.
   */
  describe("headIsAtBase (docs/216 reset-to-base re-arm detection)", () => {
    it("true when the branch was reset --hard onto origin/<base>", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      run("git reset --hard origin/main", workDir);
      expect(await git.headIsAtBase("main")).toBe(true);
    });

    it("false for a just-merged branch still holding its own commits", async () => {
      // Squash-merged, NOT reset: feature still points at its own commit, which
      // is not in main's history — HEAD ≠ origin/main tip.
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      expect(await git.headIsAtBase("main")).toBe(false);
    });

    it("false when the branch carries new work on top of the base", async () => {
      const git = setup({ merge: "regular", rebase: true, newWork: true });
      expect(await git.headIsAtBase("main")).toBe(false);
    });

    it("returns false when origin/<base> is missing (fail safe)", async () => {
      const git = setup({ merge: "regular", rebase: false, newWork: false });
      expect(await git.headIsAtBase("does-not-exist")).toBe(false);
    });
  });

  /**
   * docs/218 — the git primitives behind the pre-turn auto-reset: detached-HEAD
   * detection, sequencer-in-progress detection, and the hard reset itself.
   */
  describe("currentBranchOrNull / isMergeOrSequencerInProgress / resetHardToRemoteBase (docs/218)", () => {
    it("currentBranchOrNull returns the branch name when on a branch", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      expect(await git.currentBranchOrNull()).toBe("feature");
    });

    it("currentBranchOrNull returns null on a detached HEAD", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      run("git checkout --detach", workDir);
      expect(await git.currentBranchOrNull()).toBeNull();
    });

    it("isMergeOrSequencerInProgress is false on a clean checkout", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      expect(await git.isMergeOrSequencerInProgress()).toBe(false);
    });

    it("isMergeOrSequencerInProgress is true mid-conflicted-merge", async () => {
      // Create a conflicting commit on main and on the branch, then attempt a
      // merge that stops with MERGE_HEAD present.
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      run("git reset --hard origin/main", workDir);
      run("git checkout -b conflict-branch", workDir);
      fs.writeFileSync(path.join(workDir, "base.txt"), "branch side\n");
      run("git add -A && git commit -m 'branch edit'", workDir);
      // Advance main on the remote with a conflicting change, fetch it.
      run("git fetch origin", maintainerDir);
      run("git checkout main", maintainerDir);
      fs.writeFileSync(path.join(maintainerDir, "base.txt"), "main side\n");
      run("git add -A && git commit -m 'main edit'", maintainerDir);
      run("git push origin main", maintainerDir);
      run("git fetch origin", workDir);
      try {
        run("git merge origin/main", workDir);
      } catch {
        // expected: merge stops with conflicts, leaving MERGE_HEAD.
      }
      expect(await git.isMergeOrSequencerInProgress()).toBe(true);
    });

    it("resetHardToRemoteBase moves the branch to origin/<base> and reports from→to", async () => {
      // Squash-merged, branch still at its own (now-phantom) commit.
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      const before = await git.getHeadHash();
      const baseTip = run("git rev-parse origin/main", workDir).trim();

      const { from, to } = await git.resetHardToRemoteBase("main");

      expect(from).toBe(before);
      expect(to).toBe(baseTip);
      expect(await git.getHeadHash()).toBe(baseTip);
      expect(await git.headIsAtBase("main")).toBe(true);
    });

    it("resetHardToRemoteBase throws when origin/<base> can't be resolved", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      await expect(git.resetHardToRemoteBase("does-not-exist")).rejects.toThrow();
    });
  });
});
