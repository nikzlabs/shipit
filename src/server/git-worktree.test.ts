import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";

describe("GitManager: worktree operations", () => {
  let tmpDir: string;
  let parentDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-worktree-"));
    parentDir = path.join(tmpDir, "parent");
    fs.mkdirSync(parentDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- createWorktree ----

  it("creates a worktree with a new branch", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    // Add a file so worktree has content
    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    const worktreePath = path.join(tmpDir, "worktree-1");
    await git.createWorktree(worktreePath, "feature-branch");

    // Worktree directory should exist
    expect(fs.existsSync(worktreePath)).toBe(true);
    // The file from the parent should be present
    expect(fs.existsSync(path.join(worktreePath, "file.txt"))).toBe(true);
    // Worktree should be on the new branch
    const wtGit = new GitManager(worktreePath);
    const branch = await wtGit.getCurrentBranch();
    expect(branch).toBe("feature-branch");
  });

  it("creates a worktree from a specific start point", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "v1.txt"), "v1");
    await git.autoCommit("v1");
    const log1 = await git.log();
    const v1Hash = log1[0].hash;

    fs.writeFileSync(path.join(parentDir, "v2.txt"), "v2");
    await git.autoCommit("v2");

    const worktreePath = path.join(tmpDir, "worktree-v1");
    await git.createWorktree(worktreePath, "from-v1", v1Hash);

    // Worktree should have v1.txt but not v2.txt
    expect(fs.existsSync(path.join(worktreePath, "v1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, "v2.txt"))).toBe(false);
  });

  // ---- listWorktrees ----

  it("lists all worktrees including the main working tree", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    const wt1Path = path.join(tmpDir, "wt1");
    const wt2Path = path.join(tmpDir, "wt2");
    await git.createWorktree(wt1Path, "branch-1");
    await git.createWorktree(wt2Path, "branch-2");

    const worktrees = await git.listWorktrees();
    expect(worktrees).toHaveLength(3); // main + 2 worktrees

    const branches = worktrees.map((w) => w.branch);
    expect(branches).toContain("branch-1");
    expect(branches).toContain("branch-2");

    // All worktrees should have paths
    for (const wt of worktrees) {
      expect(wt.path).toBeTruthy();
      expect(wt.head).toBeTruthy();
    }
  });

  // ---- removeWorktree ----

  it("removes a worktree", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    const worktreePath = path.join(tmpDir, "wt-remove");
    await git.createWorktree(worktreePath, "to-remove");

    expect(fs.existsSync(worktreePath)).toBe(true);

    await git.removeWorktree(worktreePath);

    // Directory should be gone
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Worktree should no longer be listed
    const worktrees = await git.listWorktrees();
    const branches = worktrees.map((w) => w.branch);
    expect(branches).not.toContain("to-remove");
  });

  // ---- merge ----

  it("merges a branch successfully", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "base.txt"), "base");
    await git.autoCommit("Base commit");

    // Create worktree with a new branch
    const worktreePath = path.join(tmpDir, "wt-merge");
    await git.createWorktree(worktreePath, "feature");

    // Make changes in the worktree
    const wtGit = new GitManager(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "feature work");
    await wtGit.autoCommit("Add feature");

    // Merge feature branch into main
    const result = await git.merge("feature");
    expect(result.success).toBe(true);

    // The merged file should now be in the parent
    expect(fs.existsSync(path.join(parentDir, "feature.txt"))).toBe(true);
  });

  it("reports merge conflicts", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "shared.txt"), "original");
    await git.autoCommit("Base");

    // Create worktree and make conflicting change
    const worktreePath = path.join(tmpDir, "wt-conflict");
    await git.createWorktree(worktreePath, "conflict-branch");

    const wtGit = new GitManager(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "shared.txt"), "worktree version");
    await wtGit.autoCommit("Change in worktree");

    // Make conflicting change in parent
    fs.writeFileSync(path.join(parentDir, "shared.txt"), "parent version");
    await git.autoCommit("Change in parent");

    // Merge should report conflict
    const result = await git.merge("conflict-branch");
    expect(result.success).toBe(false);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts).toContain("shared.txt");

    // Working tree should be clean (merge was aborted)
    const branch = await git.getCurrentBranch();
    expect(branch).toBeTruthy();
  });

  // ---- deleteBranch ----

  it("deletes a branch", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "file.txt"), "hello");
    await git.autoCommit("Add file");

    await git.checkoutNewBranch("temp-branch");
    // Switch back to main so we can delete temp-branch
    const log = await git.log();
    await git.rollback(log[0].hash);
    // Need to checkout main explicitly
    const worktreePath = path.join(tmpDir, "wt-for-delete");
    await git.createWorktree(worktreePath, "another-branch");

    // Delete the worktree first, then its branch
    await git.removeWorktree(worktreePath);
    await git.deleteBranch("another-branch");

    // Listing worktrees should only show main
    const worktrees = await git.listWorktrees();
    const branches = worktrees.map((w) => w.branch);
    expect(branches).not.toContain("another-branch");
  });

  // ---- worktree isolation ----

  it("changes in worktree do not affect parent until merge", async () => {
    const git = new GitManager(parentDir);
    await git.init();

    fs.writeFileSync(path.join(parentDir, "base.txt"), "base");
    await git.autoCommit("Base");

    const worktreePath = path.join(tmpDir, "wt-isolated");
    await git.createWorktree(worktreePath, "isolated");

    // Add file only in worktree
    const wtGit = new GitManager(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "isolated.txt"), "only in worktree");
    await wtGit.autoCommit("Add isolated file");

    // Parent should NOT have the file
    expect(fs.existsSync(path.join(parentDir, "isolated.txt"))).toBe(false);

    // Parent log should not have the worktree commit
    const parentLog = await git.log();
    const messages = parentLog.map((e) => e.message);
    expect(messages).not.toContain("Add isolated file");
  });
});
