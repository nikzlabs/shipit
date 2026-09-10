import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { classifyBranchSync, guardMergeSync, readBranchSync, resolveMergeSync } from "./branch-sync.js";

// Real git verifies count order and tracking-ref updates on single-branch fetch.
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
    expect(verdict.action === "hold" && verdict.message).toContain("2 commits");
    expect(run("git rev-parse refs/heads/feature", bareDir).trim())
      .toBe(run("git rev-parse HEAD", workDir).trim());
    expect(await readBranchSync(git, "feature")).toEqual({ state: "in-sync", ahead: 0, behind: 0 });
    expect(verdict.action === "hold" && verdict.pushed).toBe(true);
  });

  it("holds the merge on `diverged`, and does NOT try to repair it", async () => {
    run(`git clone ${bareDir} .`, otherDir);
    run("git checkout feature", otherDir);
    commit(otherDir, "remote-side", "1\n");
    run("git push origin feature", otherDir);
    commit(workDir, "local-side", "1\n");
    const git = new GitManager(workDir);
    const remoteTipBefore = run("git rev-parse refs/heads/feature", bareDir).trim();

    const verdict = await guardMergeSync(git);

    expect(verdict.action).toBe("hold");
    expect(verdict.action === "hold" && verdict.message).toContain("diverged");
    expect(run("git rev-parse refs/heads/feature", bareDir).trim()).toBe(remoteTipBefore);
    expect(run("git rev-parse HEAD", workDir).trim()).not.toBe(remoteTipBefore);
    expect(verdict.action === "hold" && verdict.pushed).toBe(false);
  });

  it("lets a `behind` branch merge — the remote already contains this session's commits", async () => {
    run(`git clone ${bareDir} .`, otherDir);
    run("git checkout feature", otherDir);
    commit(otherDir, "remote-side", "1\n");
    run("git push origin feature", otherDir);
    const git = new GitManager(workDir);

    expect(await readBranchSync(git, "feature")).toEqual({ state: "in-sync", ahead: 0, behind: 0 });
    expect(await resolveMergeSync(git, "feature")).toEqual({ state: "behind", ahead: 0, behind: 1 });
    expect(await guardMergeSync(git)).toEqual({ action: "proceed" });
  });

  it("declines to answer when HEAD is on a different branch than the one asked about", async () => {
    run("git checkout -b sidequest", workDir);
    commit(workDir, "e", "1\n");
    expect(await readBranchSync(new GitManager(workDir), "feature")).toBeUndefined();
  });

  it("guards the branch that will actually be merged, not the one the card names", async () => {
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
    expect(await guardMergeSync(git)).toEqual({ action: "proceed" });
  });

  it("falls back to local refs — still catching `ahead` — when the remote is unreachable", async () => {
    commit(workDir, "c", "1\n");
    run(`git remote set-url origin ${path.join(root, "nowhere.git")}`, workDir);
    const git = new GitManager(workDir);

    expect(await resolveMergeSync(git, "feature")).toEqual({ state: "ahead", ahead: 1, behind: 0 });
    const verdict = await guardMergeSync(git);
    expect(verdict.action).toBe("hold");
    expect(verdict.action === "hold" && verdict.message).toContain("failed");
    expect(verdict.action === "hold" && verdict.pushed).toBe(false);
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
