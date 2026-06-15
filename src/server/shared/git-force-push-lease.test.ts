import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * Regression for the post-merge follow-up-PR push (docs/202 re-arm flow): a
 * merged PR's branch is rebased onto the now-advanced base and gains new work,
 * and ShipIt force-pushes it to open a *new* PR.
 *
 * The bug: `GitManager.forcePush` used a bare `--force-with-lease`, which leases
 * against the local remote-tracking ref `refs/remotes/origin/<branch>`. After
 * the merge that ref is stale — the remote branch was deleted at merge (or never
 * re-fetched) — so git rejects every push with `[rejected] (stale info)`, even
 * right after a manual `git fetch`. The fix reads the remote's LIVE tip via
 * `git ls-remote` and leases against that (or creates the ref when the remote
 * branch is gone), keeping the lease's protection without the staleness.
 */
describe("GitManager force-push lease (post-merge follow-up push)", () => {
  let root: string;
  let bareDir: string;
  let maintainerDir: string;
  let workDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  /** The bare remote's current tip for a branch (the real remote state). */
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

    // Bare remote with a seeded main branch.
    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "base.txt"), "base v1\n");
    run("git add -A && git commit -m 'base'", maintainerDir);
    run("git push origin main", maintainerDir);

    // Session clone with a feature branch carrying one commit (the "merged"
    // work). The push seeds both the remote ref and the local origin/feature
    // tracking ref at C1.
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

  /**
   * Land feature onto main on the remote (squash), DELETE the remote feature
   * branch (auto-delete-on), then in the work clone fetch (no prune, so
   * origin/feature stays stale at C1), rebase onto the advanced base, and add a
   * fresh commit — the post-merge follow-up state.
   */
  function mergeDeleteRebaseAndWork(): void {
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    run("git merge --squash origin/feature", maintainerDir);
    run("git commit -m 'Squash-merge feature'", maintainerDir);
    run("git push origin main", maintainerDir);
    run("git push origin :feature", maintainerDir); // delete remote branch at merge

    run("git fetch origin", workDir); // no --prune: origin/feature stays at C1
    run("git rebase origin/main", workDir);
    fs.writeFileSync(path.join(workDir, "follow-up.txt"), "new slice of work\n");
    run("git add -A && git commit -m 'follow-up work'", workDir);
  }

  it("repro: a bare --force-with-lease is rejected (stale info) after the merged branch is deleted + rebased", () => {
    mergeDeleteRebaseAndWork();
    expect(remoteHas("feature")).toBe(false);

    // This is exactly what the old forcePush did. The local origin/feature
    // tracking ref still names the deleted C1, so the bare lease's expected
    // value no longer matches the (absent) remote → rejected, repeatably.
    expect(() =>
      run("git push origin feature --force-with-lease --set-upstream", workDir),
    ).toThrow(/stale info|rejected|fetch first|cannot lock ref/i);
    expect(remoteHas("feature")).toBe(false);
  });

  it("forcePush() succeeds with a fresh lease when the remote branch was deleted at merge", async () => {
    mergeDeleteRebaseAndWork();
    const git = new GitManager(workDir);

    await git.forcePush("origin", "feature");

    // The follow-up branch now lives on the remote at the local HEAD.
    expect(remoteTip("feature")).toBe(headOf(workDir));
  });

  it("forcePush() succeeds when the surviving remote branch has diverged (auto-delete off)", async () => {
    // Merge but DON'T delete the remote feature branch; the work clone rebases
    // and the remote tip moves underneath via the maintainer (so the local
    // tracking ref no longer matches the live remote).
    run("git fetch origin", maintainerDir);
    run("git checkout main", maintainerDir);
    run("git merge --squash origin/feature", maintainerDir);
    run("git commit -m 'Squash-merge feature'", maintainerDir);
    run("git push origin main", maintainerDir);

    // Maintainer advances remote feature after the work clone's last fetch, so
    // origin/feature in the work clone is stale relative to the real remote.
    run("git checkout feature", maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "drift.txt"), "remote drift\n");
    run("git add -A && git commit -m 'remote drift'", maintainerDir);
    run("git push origin feature", maintainerDir);
    const driftedTip = remoteTip("feature");

    // Fetch only main, so origin/feature in the work clone stays stale at C1 —
    // exactly what makes a bare lease reject against the drifted remote tip.
    run("git fetch origin main", workDir);
    run("git rebase origin/main", workDir);
    fs.writeFileSync(path.join(workDir, "follow-up.txt"), "new slice\n");
    run("git add -A && git commit -m 'follow-up work'", workDir);

    const git = new GitManager(workDir);
    // A bare lease would reject here (stale tracking ref ≠ drifted remote); the
    // fresh lease reads the live tip and pushes the ShipIt-owned branch.
    await git.forcePush("origin", "feature");

    expect(remoteTip("feature")).toBe(headOf(workDir));
    expect(remoteTip("feature")).not.toBe(driftedTip);
  });

  it("forcePushWithLease() still REJECTS when the remote genuinely moved underneath the expected sha", async () => {
    const staleExpected = remoteTip("feature"); // C1 — what we (wrongly) believe

    // Remote feature genuinely advances to a new tip we don't know about.
    run("git fetch origin", maintainerDir);
    run("git checkout feature", maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "concurrent.txt"), "someone else\n");
    run("git add -A && git commit -m 'concurrent push'", maintainerDir);
    run("git push origin feature", maintainerDir);
    const liveTip = remoteTip("feature");
    expect(liveTip).not.toBe(staleExpected);

    // New local work to push.
    fs.writeFileSync(path.join(workDir, "mine.txt"), "my work\n");
    run("git add -A && git commit -m 'my work'", workDir);

    const git = new GitManager(workDir);
    // Leasing against the STALE expected sha must NOT clobber the concurrent
    // push — the lease still protects.
    await expect(git.forcePushWithLease("origin", "feature", staleExpected)).rejects.toThrow(
      /stale info|rejected/i,
    );
    expect(remoteTip("feature")).toBe(liveTip); // remote untouched
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

    run("git push origin :feature", maintainerDir); // delete on remote
    expect(await git.remoteBranchSha("origin", "feature")).toBeNull();
  });
});
