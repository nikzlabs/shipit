import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager, generateBranchPrefix } from "./git.js";

describe("GitManager: branch operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-branch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- checkoutNewBranch ----

  it("creates and checks out a new branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init({ name: "Test", email: "test@test.com" });

    await git.checkoutNewBranch("feature-branch");
    const branch = await git.getCurrentBranch();
    expect(branch).toBe("feature-branch");
  });

  it("preserves existing commits on new branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init({ name: "Test", email: "test@test.com" });

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");
    await git.autoCommit("Add file");

    await git.checkoutNewBranch("new-branch");
    const log = await git.log();
    expect(log.some((c) => c.message === "Add file")).toBe(true);
  });

  // ---- renameBranch ----

  it("renames the current branch", async () => {
    const git = new GitManager(tmpDir);
    await git.init({ name: "Test", email: "test@test.com" });

    await git.checkoutNewBranch("old-name");
    expect(await git.getCurrentBranch()).toBe("old-name");

    await git.renameBranch("old-name", "new-name");
    expect(await git.getCurrentBranch()).toBe("new-name");
  });
});

describe("generateBranchPrefix", () => {
  it("returns a 5-character lowercase string", () => {
    const prefix = generateBranchPrefix();
    expect(prefix).toHaveLength(5);
    expect(prefix).toMatch(/^[a-z0-9_-]+$/);
  });

  it("generates unique prefixes", () => {
    const prefixes = new Set(Array.from({ length: 20 }, () => generateBranchPrefix()));
    // With 20 random prefixes, collisions are extremely unlikely
    expect(prefixes.size).toBeGreaterThan(15);
  });
});
