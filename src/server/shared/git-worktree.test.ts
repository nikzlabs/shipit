import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitManager } from "./git.js";
import { RepoGit } from "../orchestrator/repo-git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("RepoGit: clone-based operations", () => {
  let tmpDir: string;
  let parentDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-clone-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
    parentDir = path.join(tmpDir, "parent");
    fs.mkdirSync(parentDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clones from a bare cache with hardlinked objects", async () => {
    const git = new GitManager(parentDir);
    await git.init();
    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    const cacheDir = path.join(tmpDir, "cache.git");
    fs.mkdirSync(cacheDir);
    const cacheGit = new RepoGit(cacheDir);
    await cacheGit.cloneBare(parentDir);

    const sessionDir = path.join(tmpDir, "session-1");
    await cacheGit.cloneFromCache(sessionDir);

    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "file.txt"))).toBe(true);

    expect(fs.existsSync(path.join(sessionDir, ".git"))).toBe(true);

    const sessionGit = new GitManager(sessionDir);
    const branch = await sessionGit.getCurrentBranch();
    expect(branch).toBeTruthy();
  });

  it("fetches bare cache with TTL-based deduplication", async () => {
    const git = new GitManager(parentDir);
    await git.init();
    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    const cacheDir = path.join(tmpDir, "cache.git");
    fs.mkdirSync(cacheDir);
    const cacheGit = new RepoGit(cacheDir);
    await cacheGit.cloneBare(parentDir);

    await cacheGit.fetchCache(60_000);
    const markerPath = path.join(cacheDir, ".shipit-last-fetch");
    expect(fs.existsSync(markerPath)).toBe(true);

    const mtime1 = fs.statSync(markerPath).mtimeMs;
    await cacheGit.fetchCache(60_000);
    const mtime2 = fs.statSync(markerPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("merges a branch successfully", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "base.txt"), "base");
    await git.autoCommit("Base commit");

    const cacheDir = path.join(tmpDir, "cache.git");
    fs.mkdirSync(cacheDir);
    const cacheGit = new RepoGit(cacheDir);
    await cacheGit.cloneBare(parentDir);

    const cloneDir = path.join(tmpDir, "clone-1");
    await cacheGit.cloneFromCache(cloneDir);

    const cloneGit = new GitManager(cloneDir);
    await cloneGit.checkoutNewBranch("feature");
    fs.writeFileSync(path.join(cloneDir, "feature.txt"), "feature work");
    await cloneGit.autoCommit("Add feature");

    await simpleGit(cloneDir).checkout("main");
    const result = await cloneGit.merge("feature");
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(cloneDir, "feature.txt"))).toBe(true);
  });

  it("reports merge conflicts", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "shared.txt"), "original");
    await git.autoCommit("Base");

    const cacheDir = path.join(tmpDir, "cache.git");
    fs.mkdirSync(cacheDir);
    const cacheGit = new RepoGit(cacheDir);
    await cacheGit.cloneBare(parentDir);

    const cloneDir = path.join(tmpDir, "clone-conflict");
    await cacheGit.cloneFromCache(cloneDir);

    const cloneGit = new GitManager(cloneDir);
    await cloneGit.checkoutNewBranch("conflict-branch");
    fs.writeFileSync(path.join(cloneDir, "shared.txt"), "branch version");
    await cloneGit.autoCommit("Change in branch");

    await simpleGit(cloneDir).checkout("main");
    fs.writeFileSync(path.join(cloneDir, "shared.txt"), "main version");
    await cloneGit.autoCommit("Change in main");

    const result = await cloneGit.merge("conflict-branch");
    expect(result.success).toBe(false);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts).toContain("shared.txt");

    const branch = await cloneGit.getCurrentBranch();
    expect(branch).toBeTruthy();
  });

  it("detects empty repo", async () => {
    const git = new GitManager(parentDir);
    const repo = new RepoGit(parentDir);

    await git.init();

    expect(await repo.isEmpty()).toBe(false);
  });

  it("changes in one clone do not affect another clone", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "base.txt"), "base");
    await git.autoCommit("Base");

    const cacheDir = path.join(tmpDir, "cache.git");
    fs.mkdirSync(cacheDir);
    const cacheGit = new RepoGit(cacheDir);
    await cacheGit.cloneBare(parentDir);

    const clone1Dir = path.join(tmpDir, "clone-1");
    const clone2Dir = path.join(tmpDir, "clone-2");
    await cacheGit.cloneFromCache(clone1Dir);
    await cacheGit.cloneFromCache(clone2Dir);

    const clone1Git = new GitManager(clone1Dir);
    fs.writeFileSync(path.join(clone1Dir, "isolated.txt"), "only in clone1");
    await clone1Git.autoCommit("Add isolated file");

    expect(fs.existsSync(path.join(clone2Dir, "isolated.txt"))).toBe(false);

    const clone2Git = new GitManager(clone2Dir);
    const clone2Log = await clone2Git.log();
    const messages = clone2Log.map((e) => e.message);
    expect(messages).not.toContain("Add isolated file");
  });
});
