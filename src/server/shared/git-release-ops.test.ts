import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

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

  it("createBranchFrom creates a branch at a start point and checks it out", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "1", "base commit");
    const base = await git.getHeadHash();

    await commit(git, "b.txt", "2", "second commit");

    await git.createBranchFrom("release/1.0.0", base!);
    expect(await git.getCurrentBranch()).toBe("release/1.0.0");
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

    await git.resetBranchTo("release/1.0.0", advanced!);
    expect(await git.getCurrentBranch()).toBe("release/1.0.0");
    expect(await git.getHeadHash()).toBe(advanced);
    expect(fs.existsSync(path.join(tmpDir, "c.txt"))).toBe(false);
  });

  it("cherryPick applies a commit from another branch onto the current branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    await commit(git, "a.txt", "base", "base");
    const base = await git.getHeadHash();

    await commit(git, "fix.txt", "fixed", "hotfix");
    const fixSha = await git.getHeadHash();

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

    await commit(git, "shared.txt", "main-change\n", "main change");
    const conflictSha = await git.getHeadHash();

    await git.createBranchFrom("release/1.0.1", base!);
    await commit(git, "shared.txt", "release-change\n", "release change");

    const res = await git.cherryPick([conflictSha!]);
    expect(res.success).toBe(false);
    expect(res.conflictedSha).toBe(conflictSha);
    expect(await git.isClean()).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "shared.txt"), "utf8")).toBe("release-change\n");
  });

  it("cherryPick is a no-op for an empty sha list", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    expect(await git.cherryPick([])).toEqual({ success: true });
  });

  function readFile(rel: string): string {
    try {
      return fs.readFileSync(path.join(tmpDir, rel), "utf8");
    } catch {
      return "";
    }
  }

  async function setupDivergence(git: GitManager): Promise<void> {
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "base\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
    await git.autoCommit("base");
    const baseSha = await git.getHeadHash();

    fs.writeFileSync(path.join(tmpDir, "code.ts"), "main-code\n");
    fs.writeFileSync(path.join(tmpDir, "package.json"), `${JSON.stringify({ version: "1.0.0" })}\n`);
    fs.writeFileSync(path.join(tmpDir, "main-only.ts"), "main-only\n");
    await git.autoCommit("main change");
    await tagLocal(tmpDir, "mainref");

    await git.createBranchFrom("release/1.0.0", baseSha!);
    fs.writeFileSync(path.join(tmpDir, "code.ts"), "stable-hotfix\n");
    fs.writeFileSync(path.join(tmpDir, "stable-only.ts"), "stable-only\n");
    await git.autoCommit("stable hotfix");
  }

  it("mergeOverride takes the incoming tree wholesale through a real code conflict, no abort", async () => {
    const git = new GitManager(tmpDir);
    await setupDivergence(git);
    const releaseTip = await git.getHeadHash();

    const plain = await git.merge("mainref");
    expect(plain.success).toBe(false);
    expect(plain.conflicts).toContain("code.ts");

    await git.mergeOverride("mainref");
    expect(await git.isClean()).toBe(true);

    expect(readFile("code.ts")).toBe("main-code\n");
    expect(readFile("main-only.ts")).toBe("main-only\n");
    expect(fs.existsSync(path.join(tmpDir, "stable-only.ts"))).toBe(false);

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

async function tagLocal(dir: string, tag: string): Promise<void> {
  const { default: simpleGit } = await import("simple-git");
  await simpleGit(dir).raw(["tag", tag]);
}
