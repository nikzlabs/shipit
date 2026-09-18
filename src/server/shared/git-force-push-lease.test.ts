import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager force-push lease (post-merge follow-up push)", () => {
  let root: string;
  let bareDir: string;
  let maintainerDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  const remoteTip = (branch: string): string =>
    run(`git rev-parse refs/heads/${branch}`, bareDir).trim();

  const remoteHas = (branch: string): boolean => {
    try {
      remoteTip(branch);
      return true;
    } catch {
      return false;
    }
  };

  const headOf = (dir: string): string => run("git rev-parse HEAD", dir).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-force-lease-"));
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

  function mergeDeleteRebaseAndWork(): void {
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    run("git merge --squash origin/feature", maintainerDir);
    run("git commit -m 'Squash-merge feature'", maintainerDir);
    run("git push origin main", maintainerDir);
    run("git push origin :feature", maintainerDir);

    run("git fetch origin", workDir); // No prune: preserve the stale origin/feature ref.
    run("git rebase origin/main", workDir);
    fs.writeFileSync(path.join(workDir, "follow-up.txt"), "new slice of work\n");
    run("git add -A && git commit -m 'follow-up work'", workDir);
  }

  it("repro: a bare --force-with-lease is rejected (stale info) after the merged branch is deleted + rebased", () => {
    mergeDeleteRebaseAndWork();
    expect(remoteHas("feature")).toBe(false);

    expect(() =>
      run("git push origin feature --force-with-lease --set-upstream", workDir),
    ).toThrow(/stale info|rejected|fetch first|cannot lock ref/i);
    expect(remoteHas("feature")).toBe(false);
  });

  it("forcePush() succeeds with a fresh lease when the remote branch was deleted at merge", async () => {
    mergeDeleteRebaseAndWork();
    const git = new GitManager(workDir);

    await git.forcePush("origin", "feature");

    expect(remoteTip("feature")).toBe(headOf(workDir));
  });

  it("forcePush() succeeds when the surviving remote branch has diverged (auto-delete off)", async () => {
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    run("git merge --squash origin/feature", maintainerDir);
    run("git commit -m 'Squash-merge feature'", maintainerDir);
    run("git push origin main", maintainerDir);

    run("git checkout feature", maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "drift.txt"), "remote drift\n");
    run("git add -A && git commit -m 'remote drift'", maintainerDir);
    run("git push origin feature", maintainerDir);
    const driftedTip = remoteTip("feature");

    // Fetch only main to preserve the stale feature tracking ref.
    run("git fetch origin main", workDir);
    run("git rebase origin/main", workDir);
    fs.writeFileSync(path.join(workDir, "follow-up.txt"), "new slice\n");
    run("git add -A && git commit -m 'follow-up work'", workDir);

    const git = new GitManager(workDir);
    await git.forcePush("origin", "feature");

    expect(remoteTip("feature")).toBe(headOf(workDir));
    expect(remoteTip("feature")).not.toBe(driftedTip);
  });

  it("forcePushWithLease() still REJECTS when the remote genuinely moved underneath the expected sha", async () => {
    const staleExpected = remoteTip("feature");

    run("git fetch origin", maintainerDir);
    run("git checkout feature", maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "concurrent.txt"), "someone else\n");
    run("git add -A && git commit -m 'concurrent push'", maintainerDir);
    run("git push origin feature", maintainerDir);
    const liveTip = remoteTip("feature");
    expect(liveTip).not.toBe(staleExpected);

    fs.writeFileSync(path.join(workDir, "mine.txt"), "my work\n");
    run("git add -A && git commit -m 'my work'", workDir);

    const git = new GitManager(workDir);
    await expect(git.forcePushWithLease("origin", "feature", staleExpected)).rejects.toThrow(
      /stale info|rejected/i,
    );
    expect(remoteTip("feature")).toBe(liveTip);
  });

  it("forcePushWithLease() succeeds with the correct (fresh) expected sha", async () => {
    const git = new GitManager(workDir);
    const fresh = await git.remoteBranchSha("origin", "feature");
    expect(fresh).toBe(remoteTip("feature"));

    fs.writeFileSync(path.join(workDir, "mine.txt"), "my work\n");
    run("git add -A && git commit -m 'my work'", workDir);

    await git.forcePushWithLease("origin", "feature", fresh);
    expect(remoteTip("feature")).toBe(headOf(workDir));
  });

  it("remoteBranchSha() returns the live remote tip, and null when the branch is absent", async () => {
    const git = new GitManager(workDir);
    expect(await git.remoteBranchSha("origin", "feature")).toBe(remoteTip("feature"));

    run("git push origin :feature", maintainerDir);
    expect(await git.remoteBranchSha("origin", "feature")).toBeNull();
  });
});
