/**
 * `GitManager.getDefaultBranch` — the server-side answer to "what is this
 * repo's base branch?" that replaced a hard-coded "main" in the ready-card
 * diff-stat, changed-docs, and diff-route paths. A `master` (or `trunk`) repo
 * must report its own branch, not the guess.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: getDefaultBranch", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-default-branch-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

  /**
   * An "origin" repo whose default branch is `branchName`, cloned into `clone/`
   * — i.e. exactly the shape a session's working copy has.
   */
  function makeOriginAndClone(branchName: string): string {
    const origin = path.join(tmpDir, "origin");
    fs.mkdirSync(origin);
    git(origin, "init", "-b", branchName);
    fs.writeFileSync(path.join(origin, "a.txt"), "a\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "base");

    const clone = path.join(tmpDir, "clone");
    git(tmpDir, "clone", origin, clone);
    return clone;
  }

  it("reports master for a master-default repo", async () => {
    const clone = makeOriginAndClone("master");
    expect(await new GitManager(clone).getDefaultBranch()).toBe("master");
  });

  it("reports main for a main-default repo", async () => {
    const clone = makeOriginAndClone("main");
    expect(await new GitManager(clone).getDefaultBranch()).toBe("main");
  });

  it("reports a wholly unconventional default branch", async () => {
    const clone = makeOriginAndClone("trunk");
    expect(await new GitManager(clone).getDefaultBranch()).toBe("trunk");
  });

  it("probes origin/* when origin/HEAD is missing (older clone)", async () => {
    const clone = makeOriginAndClone("master");
    // Older clones (and some fetch-only setups) have no refs/remotes/origin/HEAD.
    git(clone, "remote", "set-head", "origin", "--delete");
    expect(await new GitManager(clone).getDefaultBranch()).toBe("master");
  });

  it("falls back to main for a repo with no remote at all", async () => {
    const local = new GitManager(tmpDir);
    await local.init();
    // Nothing to read — degrade to the pre-existing guess rather than throwing.
    expect(await local.getDefaultBranch()).toBe("main");
  });
});
