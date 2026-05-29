import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    const { commitHash, skippedConflictedFiles } = await git.autoCommit("Add hello.txt");

    expect(commitHash).toBeTruthy();
    expect(typeof commitHash).toBe("string");
    expect(skippedConflictedFiles).toEqual([]);

    const log = await git.log();
    expect(log[0].message).toBe("Add hello.txt");
  });

  it("returns null commitHash when there is nothing to commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const { commitHash, skippedConflictedFiles } = await git.autoCommit("Nothing here");
    expect(commitHash).toBeNull();
    expect(skippedConflictedFiles).toEqual([]);
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

  // ---- conflict markers ----

  const CONFLICTED_CONTENT = [
    "before",
    "<<<<<<< HEAD",
    "ours",
    "=======",
    "theirs",
    ">>>>>>> feature",
    "after",
    "",
  ].join("\n");

  it("excludes files with conflict markers from the commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "clean.txt"), "all good");
    fs.writeFileSync(path.join(tmpDir, "conflicted.txt"), CONFLICTED_CONTENT);
    const { commitHash, skippedConflictedFiles } = await git.autoCommit("Mixed turn");

    expect(commitHash).toBeTruthy();
    expect(skippedConflictedFiles).toEqual(["conflicted.txt"]);

    // The conflicted file must remain in the working tree as an uncommitted change.
    const log = await git.log();
    expect(log[0].message).toBe("Mixed turn");
    const showed = await git.getFileAtCommit(commitHash!, "conflicted.txt");
    expect(showed).toBe("");
    expect(fs.readFileSync(path.join(tmpDir, "conflicted.txt"), "utf-8")).toBe(CONFLICTED_CONTENT);
  });

  it("returns null commitHash when every changed file has conflict markers", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "a.txt"), CONFLICTED_CONTENT);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), CONFLICTED_CONTENT.replace("HEAD", "main"));
    const { commitHash, skippedConflictedFiles } = await git.autoCommit("All conflicted");

    expect(commitHash).toBeNull();
    expect(skippedConflictedFiles.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("does not treat coincidental delimiter-looking text as a conflict marker", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    // Code that mentions the marker characters but doesn't form a real marker
    // (no `<<<<<<< label` line) must still get committed.
    const lookalike = [
      "// docs reference: <<<<<<< is the start of a git conflict marker",
      "const sep = '=======';",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(tmpDir, "doc.md"), lookalike);
    const { commitHash, skippedConflictedFiles } = await git.autoCommit("Docs");

    expect(commitHash).toBeTruthy();
    expect(skippedConflictedFiles).toEqual([]);
  });
});
