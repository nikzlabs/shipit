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
});
