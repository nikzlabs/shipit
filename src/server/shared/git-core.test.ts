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
    const hash = await git.autoCommit("Add hello.txt");

    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");

    const log = await git.log();
    expect(log[0].message).toBe("Add hello.txt");
  });

  it("returns null when there is nothing to commit", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const hash = await git.autoCommit("Nothing here");
    expect(hash).toBeNull();
  });

  it("commits modified files", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "v1");
    await git.autoCommit("v1");

    fs.writeFileSync(filePath, "v2");
    const hash = await git.autoCommit("v2");

    expect(hash).toBeTruthy();
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
    const hash = await git.autoCommit("Delete file");

    expect(hash).toBeTruthy();
  });

  it("uses default message when summary is empty", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    await git.autoCommit("");

    const log = await git.log();
    expect(log[0].message).toBe("Claude turn");
  });
});
