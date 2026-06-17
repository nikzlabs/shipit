import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * docs/214 — the release-prepare git primitives: createBranchFrom/resetBranchTo
 * (checkout -B), cherryPick (abort + surface on conflict), and listTags.
 */
describe("GitManager: release-prepare git ops", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-git-release-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function commit(git: GitManager, file: string, content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(tmpDir, file), content);
    await git.autoCommit(message);
  }

  // ---- createBranchFrom / resetBranchTo ----

  it("createBranchFrom creates a branch at a start point and checks it out", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "1", "base commit");
    const base = await git.getHeadHash();

    await commit(git, "b.txt", "2", "second commit");

    await git.createBranchFrom("release/1.0.0", base!);
    expect(await git.getCurrentBranch()).toBe("release/1.0.0");
    // The head branch was created at `base`, so the second commit's file is gone.
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(false);
  });

  it("resetBranchTo force-resets an existing branch to a new start point", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "1", "base commit");
    const base = await git.getHeadHash();
    await commit(git, "b.txt", "2", "advance main");
    const advanced = await git.getHeadHash();

    await git.createBranchFrom("release/1.0.0", base!);
    await commit(git, "c.txt", "3", "work on release branch");

    // Re-running prepare resets the same head branch back to the (advanced) base.
    await git.resetBranchTo("release/1.0.0", advanced!);
    expect(await git.getCurrentBranch()).toBe("release/1.0.0");
    expect(await git.getHeadHash()).toBe(advanced);
    expect(fs.existsSync(path.join(tmpDir, "c.txt"))).toBe(false);
  });

  // ---- cherryPick ----

  it("cherryPick applies a commit from another branch onto the current branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "base", "base");
    const base = await git.getHeadHash();

    // A fix commit on main.
    await commit(git, "fix.txt", "fixed", "hotfix");
    const fixSha = await git.getHeadHash();

    // Branch off base, cherry-pick the fix.
    await git.createBranchFrom("release/1.0.1", base!);
    const res = await git.cherryPick([fixSha!]);
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "fix.txt"), "utf8")).toBe("fixed");
  });

  it("cherryPick aborts and surfaces the conflicting sha on conflict", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "shared.txt", "base\n", "base");
    const base = await git.getHeadHash();

    // Conflicting change on main.
    await commit(git, "shared.txt", "main-change\n", "main change");
    const conflictSha = await git.getHeadHash();

    // Branch off base and make a divergent change to the same file.
    await git.createBranchFrom("release/1.0.1", base!);
    await commit(git, "shared.txt", "release-change\n", "release change");

    const res = await git.cherryPick([conflictSha!]);
    expect(res.success).toBe(false);
    expect(res.conflictedSha).toBe(conflictSha);
    // The pick was aborted — the tree is clean (no conflict markers committed).
    expect(await git.isClean()).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "shared.txt"), "utf8")).toBe("release-change\n");
  });

  it("cherryPick is a no-op for an empty sha list", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    expect(await git.cherryPick([])).toEqual({ success: true });
  });

  // ---- listTags ----

  it("listTags returns tags, optionally filtered by a glob", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "1", "base");
    await tagLocal(tmpDir, "v1.0.0");
    await tagLocal(tmpDir, "v1.1.0-rc.1");
    await tagLocal(tmpDir, "v1.1.0-rc.2");

    const all = await git.listTags();
    expect(all).toContain("v1.0.0");
    expect(all).toContain("v1.1.0-rc.2");

    const rcs = await git.listTags("v1.1.0-rc.*");
    expect(rcs.sort()).toEqual(["v1.1.0-rc.1", "v1.1.0-rc.2"]);
  });
});

/** Create a lightweight tag at HEAD without pushing (test helper). */
async function tagLocal(dir: string, tag: string): Promise<void> {
  const { default: simpleGit } = await import("simple-git");
  await simpleGit(dir).raw(["tag", tag]);
}
