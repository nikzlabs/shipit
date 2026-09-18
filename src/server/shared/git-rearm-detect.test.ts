import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

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

    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "base.txt"), "base v1\n");
    run("git add -A && git commit -m 'base'", maintainerDir);
    run("git push origin main", maintainerDir);

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

  function mergeIntoMain(kind: "regular" | "squash"): void {
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    if (kind === "regular") {
      run("git merge --no-ff -m 'Merge feature' origin/feature", maintainerDir);
    } else {
      run("git merge --squash origin/feature", maintainerDir);
      run("git commit -m 'Squash-merge feature'", maintainerDir);
    }
    run("git push origin main", maintainerDir);
    run("git fetch origin", workDir);
  }

  function setup(opts: { merge: "regular" | "squash"; rebase: boolean; newWork: boolean }): GitManager {
    mergeIntoMain(opts.merge);
    if (opts.rebase) {
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

  describe("mergedBaseProgress (which clause refused)", () => {
    it("names the containment failure when the base moved on under the branch", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: true });
      expect(await git.mergedBaseProgress("main")).toBe("base-not-contained");
    });

    it("names the empty diff when the branch is on the base with nothing new", async () => {
      const git = setup({ merge: "squash", rebase: true, newWork: false });
      expect(await git.mergedBaseProgress("main")).toBe("no-new-work");
    });

    it("reports progressed when both clauses hold", async () => {
      const git = setup({ merge: "squash", rebase: true, newWork: true });
      expect(await git.mergedBaseProgress("main")).toBe("progressed");
    });

    it("reports base-unknown when origin/<base> is missing", async () => {
      const git = setup({ merge: "regular", rebase: true, newWork: true });
      expect(await git.mergedBaseProgress("does-not-exist")).toBe("base-unknown");
    });

    it("a STALE origin/main inverts the answer — the fetch is a precondition, not an optimisation", async () => {
      run("git fetch origin", maintainerDir);
      run("git checkout main", maintainerDir);
      run("git merge --squash origin/feature", maintainerDir);
      run("git commit -m 'Squash-merge feature'", maintainerDir);
      run("git push origin main", maintainerDir);
      const git = new GitManager(workDir);

      expect(await git.mergedBaseProgress("main")).toBe("progressed");
      expect(await git.advancedBeyondMergedBase("main")).toBe(true);

      run("git fetch origin", workDir);

      expect(await git.mergedBaseProgress("main")).toBe("base-not-contained");
      expect(await git.advancedBeyondMergedBase("main")).toBe(false);
    });

    it("an ordinary `git merge origin/main` turns base-not-contained into progressed", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: true });
      expect(await git.mergedBaseProgress("main")).toBe("base-not-contained");

      run("git merge --no-edit origin/main", workDir);

      expect(await git.mergedBaseProgress("main")).toBe("progressed");
      expect(await git.advancedBeyondMergedBase("main")).toBe(true);
      const diff = run("git diff --name-only origin/main..HEAD", workDir).trim();
      expect(diff).toBe("new-work.txt");
    });
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

  describe("headIsAtBase (docs/216 reset-to-base re-arm detection)", () => {
    it("true when the branch was reset --hard onto origin/<base>", async () => {
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      run("git reset --hard origin/main", workDir);
      expect(await git.headIsAtBase("main")).toBe(true);
    });

    it("false for a just-merged branch still holding its own commits", async () => {
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
      const git = setup({ merge: "squash", rebase: false, newWork: false });
      run("git reset --hard origin/main", workDir);
      run("git checkout -b conflict-branch", workDir);
      fs.writeFileSync(path.join(workDir, "base.txt"), "branch side\n");
      run("git add -A && git commit -m 'branch edit'", workDir);
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

  describe("stale origin/<base> — the precondition callers must satisfy", () => {
    function mergeOnRemoteWithoutFetchingTheClone(): void {
      run("git fetch origin", maintainerDir);
      run("git checkout main", maintainerDir);
      run("git merge --squash origin/feature", maintainerDir);
      run("git commit -m 'Squash-merge feature'", maintainerDir);
      fs.writeFileSync(path.join(maintainerDir, "other.txt"), "someone else's work\n");
      run("git add -A && git commit -m 'other work'", maintainerDir);
      run("git push origin main", maintainerDir);
    }

    it("false-positives on an untouched merged branch while the base ref is stale", async () => {
      mergeOnRemoteWithoutFetchingTheClone();
      const git = new GitManager(workDir);
      expect(await git.advancedBeyondMergedBase("main")).toBe(true);
    });

    it("answers correctly once the base ref is freshened", async () => {
      mergeOnRemoteWithoutFetchingTheClone();
      const git = new GitManager(workDir);
      await git.fetch("origin");
      expect(await git.advancedBeyondMergedBase("main")).toBe(false);
      fs.writeFileSync(path.join(workDir, "new.txt"), "brand new\n");
      run("git add -A && git commit -m 'new work'", workDir);
      expect(await git.advancedBeyondMergedBase("main")).toBe(false);
    });
  });
});
