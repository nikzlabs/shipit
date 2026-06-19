import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
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

  // ---- mergeOverride (docs/214 — take incoming tree wholesale, conflict-proof) ----

  /** Read a worktree file (relative path), or "" if absent. */
  function readFile(rel: string): string {
    try {
      return fs.readFileSync(path.join(tmpDir, rel), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Build a stable↔main divergence that WOULD conflict on a regular merge:
   *   base → main commit (touches code.ts + package.json, adds new.txt)
   *        → release/1.0.0 off stable (which independently touches the same files)
   * Leaves the repo checked out on `release/1.0.0` with a `mainref` tag at main.
   */
  async function setupDivergence(git: GitManager): Promise<void> {
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "base\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
    await git.autoCommit("base");
    const baseSha = await git.getHeadHash();

    // main diverges: edits the shared source file, the version file, adds a file.
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "main-code\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
    fs.writeFileSync(path.join(tmpDir, "main-only.ts"), "main-only\n");
    await git.autoCommit("main change");
    await tagLocal(tmpDir, "mainref");

    // stable/release diverges off base: a hotfix that edits the SAME source file
    // (real code conflict) plus a stale-only file main never had.
    await git.createBranchFrom("release/1.0.0", baseSha!);
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "stable-hotfix\n");
    fs.writeFileSync(path.join(tmpDir, "stable-only.ts"), "stable-only\n");
    await git.autoCommit("stable hotfix");
  }

  it("mergeOverride takes the incoming tree wholesale through a real code conflict, no abort", async () => {
    const git = new GitManager(tmpDir);
    await setupDivergence(git);
    const releaseTip = await git.getHeadHash();

    // A plain merge here WOULD conflict on code.ts — prove that first.
    const plain = await git.merge("mainref");
    expect(plain.success).toBe(false);
    expect(plain.conflicts).toContain("code.ts");

    // mergeOverride never conflicts and yields main's tree exactly.
    await git.mergeOverride("mainref");
    expect(await git.isClean()).toBe(true);

    // Tree == mainref's tree byte-for-byte: incoming content, main-only file
    // present, stable-only file GONE (fully overridden).
    expect(readFile("code.ts")).toBe("main-code\n");
    expect(readFile("main-only.ts")).toBe("main-only\n");
    expect(fs.existsSync(path.join(tmpDir, "stable-only.ts"))).toBe(false);

    // 2-parent merge commit whose FIRST parent is the release tip (so the bump PR
    // stays a clean descendant of stable) and second parent is main.
    const sg = simpleGit(tmpDir);
    const parents = (await sg.raw(["log", "-1", "--format=%P"])).trim().split(/\s+/);
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(releaseTip);
    const mainSha = (await sg.revparse(["mainref"])).trim();
    expect(parents[1]).toBe(mainSha);
  });

  it("mergeOverride produces a tree identical to the incoming ref (full override)", async () => {
    const git = new GitManager(tmpDir);
    await setupDivergence(git);
    await git.mergeOverride("mainref");

    const sg = simpleGit(tmpDir);
    const headTree = (await sg.raw(["rev-parse", "HEAD^{tree}"])).trim();
    const refTree = (await sg.raw(["rev-parse", "mainref^{tree}"])).trim();
    expect(headTree).toBe(refTree);
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
