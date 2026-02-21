import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";

describe("GitManager: push and pull", () => {
  let tmpDir: string;
  let bareDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-sync-"));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-bare-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it("push sends commits to a bare remote", async () => {
    // Create a bare repo to act as the remote
    const { execSync } = await import("node:child_process");
    execSync("git init --bare -b main", { cwd: bareDir });

    const git = new GitManager(tmpDir);
    await git.init({ name: "Test", email: "test@test.com" });

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
    execSync("git init --bare -b main", { cwd: bareDir });

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
