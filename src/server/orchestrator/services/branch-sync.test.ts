import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { classifyBranchSync, guardMergeSync, readBranchSync, resolveMergeSync } from "./branch-sync.js";

/**
 * The states are read off a real repository rather than a stub, because the
 * whole guard rests on two git behaviours that a stub would simply assert into
 * existence: that `rev-list --left-right --count` reports the pair in the order
 * this code unpacks it, and that a single-branch fetch actually moves the
 * remote-tracking ref. Both have to be true of git, not of our belief about it.
 */
describe("branch-sync against a real repository", () => {
  let root: string;
  let bareDir: string;
  let workDir: string;
  let otherDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  const commit = (dir: string, file: string, body: string): void => {
    fs.writeFileSync(path.join(dir, file), body);
    run(`git add -A && git commit -m ${file}`, dir);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-branch-sync-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    workDir = path.join(root, "work");
    otherDir = path.join(root, "other");
    for (const d of [bareDir, workDir, otherDir]) fs.mkdirSync(d);

    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, workDir);
    commit(workDir, "a", "1\n");
    run("git push origin main", workDir);
    // The session's own branch, pushed — the ordinary state of a session with
    // an open pull request.
    run("git checkout -b feature", workDir);
    commit(workDir, "b", "1\n");
    run("git push origin feature", workDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads a freshly-pushed branch as in sync, and lets the merge proceed", async () => {
    const git = new GitManager(workDir);
    expect(await readBranchSync(git, "feature")).toEqual({ state: "in-sync", ahead: 0, behind: 0 });
    expect(await guardMergeSync(git)).toEqual({ action: "proceed" });
  });

  it("reads an unpushed commit as ahead — the state that merges obsolete work", async () => {
    commit(workDir, "c", "1\n");
    const git = new GitManager(workDir);
    expect(await readBranchSync(git, "feature")).toEqual({ state: "ahead", ahead: 1, behind: 0 });
  });

  it("holds the merge on `ahead`, and pushes the missing commits while it does", async () => {
    commit(workDir, "c", "1\n");
    commit(workDir, "d", "1\n");
    const git = new GitManager(workDir);

    const verdict = await guardMergeSync(git);

    expect(verdict.action).toBe("hold");
    // The count is in the message: "2 commits" is what tells the user how much
    // the merge would have dropped.
    expect(verdict.action === "hold" && verdict.message).toContain("2 commits");
    // …and the hold is not a dead end — the work reached the remote, so the
    // next click merges it.
    expect(run("git rev-parse refs/heads/feature", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());
    expect(await readBranchSync(git, "feature")).toEqual({ state: "in-sync", ahead: 0, behind: 0 });
  });

  it("holds the merge on `diverged`, and does NOT try to repair it", async () => {
    // Someone else advances the remote branch…
    run(`git clone ${bareDir} .`, otherDir);
    run("git checkout feature", otherDir);
    commit(otherDir, "remote-side", "1\n");
    run("git push origin feature", otherDir);
    // …while this clone commits its own work on the old tip.
    commit(workDir, "local-side", "1\n");
    const git = new GitManager(workDir);
    const remoteTipBefore = run("git rev-parse refs/heads/feature", bareDir).trim();

    const verdict = await guardMergeSync(git);

    expect(verdict.action).toBe("hold");
    expect(verdict.action === "hold" && verdict.message).toContain("diverged");
    // Never a force-push, and never a pull: both destroy one side's commits,
    // and which one is right is not derivable from git.
    expect(run("git rev-parse refs/heads/feature", bareDir).trim()).toBe(remoteTipBefore);
    expect(run("git rev-parse HEAD", workDir).trim()).not.toBe(remoteTipBefore);
  });

  it("lets a `behind` branch merge — the remote already contains this session's commits", async () => {
    run(`git clone ${bareDir} .`, otherDir);
    run("git checkout feature", otherDir);
    commit(otherDir, "remote-side", "1\n");
    run("git push origin feature", otherDir);
    const git = new GitManager(workDir);

    // The fetch is what makes this visible at all: before it, this clone's
    // tracking ref still names its own last push and reads as in sync.
    expect(await readBranchSync(git, "feature")).toEqual({ state: "in-sync", ahead: 0, behind: 0 });
    expect(await resolveMergeSync(git, "feature")).toEqual({ state: "behind", ahead: 0, behind: 1 });
    expect(await guardMergeSync(git)).toEqual({ action: "proceed" });
  });

  it("declines to answer when HEAD is on a different branch than the one asked about", async () => {
    run("git checkout -b sidequest", workDir);
    commit(workDir, "e", "1\n");
    // Comparing this HEAD against `origin/feature` would report a confident
    // divergence about two branches that have nothing to do with each other.
    expect(await readBranchSync(new GitManager(workDir), "feature")).toBeUndefined();
  });

  it("guards the branch that will actually be merged, not the one the card names", async () => {
    // `services/github.ts` resolves the pull request to merge from the CURRENT
    // branch. Guarding the card's branch instead reads "cannot tell" here and
    // waves through a merge of `sidequest`'s pull request, whose sync state was
    // never examined — the hole this contract closes.
    run("git checkout -b sidequest", workDir);
    commit(workDir, "e", "1\n");
    run("git push origin sidequest", workDir);
    commit(workDir, "f", "1\n");

    const verdict = await guardMergeSync(new GitManager(workDir));

    expect(verdict.action).toBe("hold");
    expect(run("git rev-parse refs/heads/sidequest", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());
  });

  it("declines to answer, and lets the merge proceed, when there is no tracking ref", async () => {
    run("git checkout -b never-pushed", workDir);
    commit(workDir, "f", "1\n");
    const git = new GitManager(workDir);
    expect(await readBranchSync(git, "never-pushed")).toBeUndefined();
    // "Cannot tell" is never a verdict — a session whose workspace was
    // reclaimed must still be able to merge.
    expect(await guardMergeSync(git)).toEqual({ action: "proceed" });
  });

  it("falls back to local refs — still catching `ahead` — when the remote is unreachable", async () => {
    commit(workDir, "c", "1\n");
    run(`git remote set-url origin ${path.join(root, "nowhere.git")}`, workDir);
    const git = new GitManager(workDir);

    // The fetch fails, so this can only see what the local refs know. That is
    // enough for the reading that blocks: unpushed commits are stale in the
    // clone's own direction, never the remote's.
    expect(await resolveMergeSync(git, "feature")).toEqual({ state: "ahead", ahead: 1, behind: 0 });
    const verdict = await guardMergeSync(git);
    expect(verdict.action).toBe("hold");
    // The push it attempts fails too, and the message says so rather than
    // claiming the work is now safe on GitHub.
    expect(verdict.action === "hold" && verdict.message).toContain("failed");
  });
});

describe("classifyBranchSync", () => {
  it("names each quadrant of the ahead/behind pair", () => {
    expect(classifyBranchSync({ ahead: 0, behind: 0 }).state).toBe("in-sync");
    expect(classifyBranchSync({ ahead: 2, behind: 0 }).state).toBe("ahead");
    expect(classifyBranchSync({ ahead: 0, behind: 3 }).state).toBe("behind");
    expect(classifyBranchSync({ ahead: 2, behind: 3 }).state).toBe("diverged");
  });
});
