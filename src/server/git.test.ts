import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";

describe("GitManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
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
  });

  describe("autoCommit", () => {
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

  describe("log", () => {
    it("returns commits in reverse chronological order", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      await git.autoCommit("First");

      fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
      await git.autoCommit("Second");

      const log = await git.log();
      expect(log[0].message).toBe("Second");
      expect(log[1].message).toBe("First");
    });

    it("respects maxCount parameter", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
      await git.autoCommit("First");

      fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
      await git.autoCommit("Second");

      const log = await git.log(1);
      expect(log).toHaveLength(1);
      expect(log[0].message).toBe("Second");
    });

    it("returns commit info with hash, message, date, and author", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      fs.writeFileSync(path.join(tmpDir, "test.txt"), "test");
      await git.autoCommit("Test commit");

      const log = await git.log();
      const commit = log[0];
      expect(commit.hash).toMatch(/^[a-f0-9]+$/);
      expect(commit.message).toBe("Test commit");
      expect(commit.date).toBeTruthy();
      expect(commit.author).toBe("ShipIt");
    });
  });

  describe("rollback", () => {
    it("resets workspace to a previous commit", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      const filePath = path.join(tmpDir, "file.txt");
      fs.writeFileSync(filePath, "original");
      await git.autoCommit("Original");

      const log1 = await git.log();
      const originalHash = log1[0].hash;

      fs.writeFileSync(filePath, "modified");
      await git.autoCommit("Modified");

      // Verify modification
      expect(fs.readFileSync(filePath, "utf-8")).toBe("modified");

      // Rollback
      await git.rollback(originalHash);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("original");
    });

    it("removes files added after the rollback target", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      const log0 = await git.log();
      const initialHash = log0[0].hash;

      fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "new");
      await git.autoCommit("Add new file");

      expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(true);

      await git.rollback(initialHash);
      expect(fs.existsSync(path.join(tmpDir, "new-file.txt"))).toBe(false);
    });
  });

  describe("remotes", () => {
    it("addRemote adds a new remote", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      await git.addRemote("origin", "https://github.com/test/repo.git");
      const remotes = await git.getRemotes();
      expect(remotes).toHaveLength(1);
      expect(remotes[0].name).toBe("origin");
      expect(remotes[0].url).toBe("https://github.com/test/repo.git");
    });

    it("addRemote updates an existing remote", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      await git.addRemote("origin", "https://github.com/test/repo1.git");
      await git.addRemote("origin", "https://github.com/test/repo2.git");

      const remotes = await git.getRemotes();
      expect(remotes).toHaveLength(1);
      expect(remotes[0].url).toBe("https://github.com/test/repo2.git");
    });

    it("getRemotes returns empty array when no remotes", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      const remotes = await git.getRemotes();
      expect(remotes).toEqual([]);
    });
  });

  describe("getCurrentBranch", () => {
    it("returns the current branch name", async () => {
      const git = new GitManager(tmpDir);
      await git.init();

      const branch = await git.getCurrentBranch();
      // Default branch name could be "main" or "master" depending on git config
      expect(typeof branch).toBe("string");
      expect(branch.length).toBeGreaterThan(0);
    });
  });

  describe("push and pull", () => {
    let bareDir: string;

    beforeEach(() => {
      bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-bare-"));
    });

    afterEach(() => {
      fs.rmSync(bareDir, { recursive: true, force: true });
    });

    it("push sends commits to a bare remote", async () => {
      // Create a bare repo to act as the remote
      const { execSync } = await import("node:child_process");
      execSync("git init --bare", { cwd: bareDir });

      const git = new GitManager(tmpDir);
      await git.init();

      // Add the bare repo as remote
      await git.addRemote("origin", bareDir);

      // Create a commit to push
      fs.writeFileSync(path.join(tmpDir, "pushed.txt"), "hello");
      await git.autoCommit("Push test");

      const branch = await git.getCurrentBranch();
      const result = await git.push("origin", branch);
      expect(result).toContain("Pushed to origin/");
    });

    it("pull fetches commits from a bare remote", async () => {
      const { execSync } = await import("node:child_process");
      execSync("git init --bare", { cwd: bareDir });

      // Clone into two working copies
      const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-clone-"));
      try {
        execSync(`git clone ${bareDir} .`, { cwd: tmpDir, stdio: "pipe" });
        execSync(`git clone ${bareDir} .`, { cwd: cloneDir, stdio: "pipe" });

        // Configure identity in clone and disable signing
        execSync('git config user.email "test@test.com"', { cwd: cloneDir });
        execSync('git config user.name "Tester"', { cwd: cloneDir });
        execSync("git config commit.gpgsign false", { cwd: cloneDir });

        // Create a commit in the clone and push
        fs.writeFileSync(path.join(cloneDir, "from-clone.txt"), "from clone");
        execSync("git add -A && git commit -m 'From clone'", { cwd: cloneDir, stdio: "pipe" });
        execSync("git push", { cwd: cloneDir, stdio: "pipe" });

        // Pull in the original
        const git = new GitManager(tmpDir);
        const branch = await git.getCurrentBranch();
        const result = await git.pull("origin", branch);
        expect(result).toContain("Pulled from origin/");
        expect(fs.existsSync(path.join(tmpDir, "from-clone.txt"))).toBe(true);
      } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    });
  });
});
