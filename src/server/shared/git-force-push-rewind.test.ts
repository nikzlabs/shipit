/**
 * A force-push must never move a remote branch strictly backwards.
 *
 * Reproduces the shape of the 2026-09-21 `main` rewind: a session clone taken
 * while `main` was at an older tip still holds that exact commit as its local
 * `main` (no fetch advances a local branch), so any path that resolves a
 * force-push target to `main` republishes it and deletes every merge since.
 * `--force-with-lease` cannot catch it — `forcePush` reads its expected SHA
 * from the live remote moments before pushing, so the lease is satisfied by
 * construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager refuses a rewinding force-push", () => {
  let root: string;
  let bareDir: string;
  let maintainerDir: string;
  let staleCloneDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

  const remoteTip = (branch: string): string => run(`git rev-parse refs/heads/${branch}`, bareDir);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-force-rewind-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    maintainerDir = path.join(root, "maintainer");
    staleCloneDir = path.join(root, "stale");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(maintainerDir);
    fs.mkdirSync(staleCloneDir);

    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, maintainerDir);
    fs.writeFileSync(path.join(maintainerDir, "pr-357.txt"), "merged\n");
    run("git add -A && git commit -m 'PR #357'", maintainerDir);
    run("git push origin main", maintainerDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A session clone taken at the old tip, after which three PRs merge. */
  function cloneThenAdvanceMain(): { oldTip: string; newTip: string } {
    run(`git clone ${bareDir} .`, staleCloneDir);
    const oldTip = run("git rev-parse main", staleCloneDir);

    for (const pr of ["359", "360", "358"]) {
      fs.writeFileSync(path.join(maintainerDir, `pr-${pr}.txt`), "merged\n");
      run(`git add -A && git commit -m 'PR #${pr}'`, maintainerDir);
    }
    run("git push origin main", maintainerDir);
    return { oldTip, newTip: remoteTip("main") };
  }

  it("refuses to publish a stale local main over three later merges", async () => {
    const { oldTip, newTip } = cloneThenAdvanceMain();
    expect(oldTip).not.toBe(newTip);

    await expect(new GitManager(staleCloneDir).forcePush("origin", "main")).rejects.toThrow(
      /BACKWARDS.*discarding 3 commit\(s\)/s,
    );
    expect(remoteTip("main")).toBe(newTip);
  });

  it("names the commits at risk even when the clone has never fetched them", async () => {
    const { newTip } = cloneThenAdvanceMain();
    // ls-remote transfers no objects, so without a fetch the ancestry test
    // would answer "unrelated" for exactly the case this guard exists for.
    expect(() => run(`git cat-file -e ${newTip}^{commit}`, staleCloneDir)).toThrow();

    await expect(new GitManager(staleCloneDir).forcePush("origin", "main")).rejects.toThrow(
      /discarding 3 commit\(s\)/,
    );
    expect(remoteTip("main")).toBe(newTip);
  });

  it("still force-pushes a rewritten branch, whose old tip is not an ancestor", async () => {
    run(`git clone ${bareDir} .`, staleCloneDir);
    run("git checkout -b feature", staleCloneDir);
    fs.writeFileSync(path.join(staleCloneDir, "feature.txt"), "v1\n");
    run("git add -A && git commit -m 'feature v1'", staleCloneDir);
    run("git push origin feature", staleCloneDir);

    run("git commit --amend -m 'feature v1 (amended)'", staleCloneDir);
    const rewritten = run("git rev-parse HEAD", staleCloneDir);

    await expect(new GitManager(staleCloneDir).forcePush("origin", "feature")).resolves.toContain(
      "Force pushed",
    );
    expect(remoteTip("feature")).toBe(rewritten);
  });

  it("still pushes a branch that is simply ahead of its remote", async () => {
    run(`git clone ${bareDir} .`, staleCloneDir);
    run("git checkout -b feature", staleCloneDir);
    fs.writeFileSync(path.join(staleCloneDir, "feature.txt"), "v1\n");
    run("git add -A && git commit -m 'feature v1'", staleCloneDir);
    run("git push origin feature", staleCloneDir);

    fs.writeFileSync(path.join(staleCloneDir, "feature.txt"), "v2\n");
    run("git add -A && git commit -m 'feature v2'", staleCloneDir);
    const ahead = run("git rev-parse HEAD", staleCloneDir);

    await expect(new GitManager(staleCloneDir).forcePush("origin", "feature")).resolves.toContain(
      "Force pushed",
    );
    expect(remoteTip("feature")).toBe(ahead);
  });
});
