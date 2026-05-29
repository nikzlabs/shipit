import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: init & autoCommit", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-core-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- init ----

  it("initializes a new git repo with an initial commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    // Should have created a .git directory
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(true);

    // Should have one commit
    const log = await git.log();
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe("Initial commit");
  });

  it("is a no-op if repo already exists", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    const log1 = await git.log();

    // Re-init should not create another commit
    await git.init();
    const log2 = await git.log();
    expect(log2).toHaveLength(log1.length);
  });

  // ---- autoCommit ----

  it("commits new files with the given summary", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello world");
    const result = await git.autoCommit("Add hello.txt");

    expect(result.commitHash).toBeTruthy();
    expect(typeof result.commitHash).toBe("string");
    expect(result.conflictedFiles).toEqual([]);
    expect(result.rebaseInProgress).toBe(false);

    const log = await git.log();
    expect(log[0].message).toBe("Add hello.txt");
  });

  it("returns null commitHash when there is nothing to commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const result = await git.autoCommit("Nothing here");
    expect(result.commitHash).toBeNull();
    expect(result.conflictedFiles).toEqual([]);
    expect(result.rebaseInProgress).toBe(false);
  });

  it("commits modified files", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "v1");
    await git.autoCommit("v1");

    fs.writeFileSync(filePath, "v2");
    const { commitHash } = await git.autoCommit("v2");

    expect(commitHash).toBeTruthy();
    const log = await git.log();
    expect(log[0].message).toBe("v2");
  });

  it("commits deleted files", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const filePath = path.join(tmpDir, "to-delete.txt");
    fs.writeFileSync(filePath, "delete me");
    await git.autoCommit("Add file");

    fs.unlinkSync(filePath);
    const { commitHash } = await git.autoCommit("Delete file");

    expect(commitHash).toBeTruthy();
  });

  it("uses default message when summary is empty", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    await git.autoCommit("");

    const log = await git.log();
    expect(log[0].message).toBe("Claude turn");
  });

  // ---- unresolved git conflict state ----

  /**
   * Set up a real merge conflict on `file.txt`: main has "main 2", feature
   * has "feature 1", both descend from a common ancestor. After calling
   * `git merge feature`, git leaves the working tree in an unmerged state
   * with the standard `<<<<<<< / ======= / >>>>>>>` markers in the file.
   */
  async function createMergeConflict(): Promise<GitManager> {
    const git = new GitManager(tmpDir);
    await git.init();
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "base\n");
    await git.autoCommit("base");

    const sg = simpleGit(tmpDir);
    await sg.checkoutLocalBranch("feature");
    fs.writeFileSync(filePath, "feature 1\n");
    await git.autoCommit("feature 1");

    await sg.checkout("main");
    fs.writeFileSync(filePath, "main 2\n");
    await git.autoCommit("main 2");

    try {
      await sg.merge(["feature"]);
    } catch {
      // Expected — merge produces a conflict.
    }
    return git;
  }

  it("refuses to commit while git reports unmerged paths", async () => {
    const git = await createMergeConflict();
    const headBeforeAutoCommit = await git.getHeadHash();

    const result = await git.autoCommit("attempted turn during merge");

    expect(result.commitHash).toBeNull();
    expect(result.conflictedFiles).toEqual(["file.txt"]);
    expect(result.rebaseInProgress).toBe(false);
    // HEAD must not have advanced — no commit was created.
    expect(await git.getHeadHash()).toBe(headBeforeAutoCommit);
  });

  it("refuses to commit while a rebase is in progress", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "base\n");
    await git.autoCommit("base");

    const sg = simpleGit(tmpDir);
    await sg.checkoutLocalBranch("feature");
    fs.writeFileSync(filePath, "feature\n");
    await git.autoCommit("feature");

    await sg.checkout("main");
    fs.writeFileSync(filePath, "main\n");
    await git.autoCommit("main");

    await sg.checkout("feature");
    // Rebase will conflict; GitManager.rebase() leaves the rebase in progress.
    const rebaseResult = await git.rebase("main");
    expect(rebaseResult.status).toBe("conflicts");
    expect(await git.isRebaseInProgress()).toBe(true);

    const headBeforeAutoCommit = await git.getHeadHash();
    const result = await git.autoCommit("attempted turn during rebase");

    expect(result.commitHash).toBeNull();
    expect(result.rebaseInProgress).toBe(true);
    expect(result.conflictedFiles.length).toBeGreaterThan(0);
    expect(await git.getHeadHash()).toBe(headBeforeAutoCommit);
  });

  it("commits files that contain marker-shaped text when git reports no conflict", async () => {
    // ShipIt's own test suite + docs reference the literal marker strings
    // (`<<<<<<<`, `=======`, `>>>>>>>`). Those edits must still get
    // committed — we trust git's `status.conflicted` instead of scanning
    // file contents.
    const git = new GitManager(tmpDir);
    await git.init();

    const codeWithMarkers = [
      "const CONFLICT_SAMPLE = `",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> feature",
      "`;",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "fixture.ts"), codeWithMarkers);

    const result = await git.autoCommit("Add conflict fixture");

    expect(result.commitHash).toBeTruthy();
    expect(result.conflictedFiles).toEqual([]);
    expect(result.rebaseInProgress).toBe(false);
  });
});
