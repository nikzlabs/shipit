import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BranchManager } from "./branches.js";

describe("BranchManager", () => {
  let tmpDir: string;
  let branchesFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-branches-test-"));
    branchesFile = path.join(tmpDir, ".vibe-branches", "branches.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a default main branch", () => {
    const manager = new BranchManager(branchesFile);
    const { branches, activeBranchId } = manager.listBranches();

    expect(branches).toHaveLength(1);
    expect(branches[0].name).toBe("main");
    expect(branches[0].isActive).toBe(true);
    expect(activeBranchId).toBe(branches[0].id);
  });

  it("creates checkpoints on the active branch", () => {
    const manager = new BranchManager(branchesFile);
    const checkpoint = manager.createCheckpoint(
      "session-1",
      2,
      "abc123",
      [{ role: "user", text: "hello" }],
      "before refactor",
    );

    const active = manager.getActiveBranch();
    expect(active.checkpoints).toHaveLength(1);
    expect(active.checkpoints[0]).toMatchObject({
      id: checkpoint.id,
      commitHash: "abc123",
      label: "before refactor",
    });
    expect(active.checkpoints[0].messages).toHaveLength(1);
  });

  it("creates a new branch from checkpoint with snapshot and commit hash", () => {
    const manager = new BranchManager(branchesFile);
    const checkpoint = manager.createCheckpoint("session-1", 1, "commit-1", [{ role: "user", text: "hi" }]);

    const result = manager.branchFromCheckpoint(checkpoint.id, "experiment");
    expect(result).not.toBeNull();
    expect(result!.branch.name).toBe("experiment");
    expect(result!.commitHash).toBe("commit-1");
    expect(result!.messages).toHaveLength(1);
  });

  it("switches active branch and returns latest checkpoint snapshot", () => {
    const manager = new BranchManager(branchesFile);
    const cp = manager.createCheckpoint("session-1", 1, "commit-1", [{ role: "user", text: "A" }]);
    const branched = manager.branchFromCheckpoint(cp.id, "branch-a");
    expect(branched).not.toBeNull();

    const main = manager.listBranches().branches.find((branch) => branch.name === "main");
    expect(main).toBeDefined();

    const switched = manager.switchBranch(main!.id);
    expect(switched).not.toBeNull();
    expect(switched!.branch.id).toBe(main!.id);
    expect(switched!.messages).toHaveLength(1);
  });

  it("persists branches and checkpoints across manager instances", () => {
    const manager1 = new BranchManager(branchesFile);
    const cp = manager1.createCheckpoint("session-1", 1, "commit-1", [{ role: "user", text: "persist" }]);
    manager1.branchFromCheckpoint(cp.id, "persisted-branch");

    const manager2 = new BranchManager(branchesFile);
    const persisted = manager2.listBranches().branches.find((b) => b.name === "persisted-branch");
    expect(persisted).toBeDefined();
    expect(persisted!.checkpoints[0].messages[0].text).toBe("persist");
  });

  it("returns null for unknown checkpoint or branch ids", () => {
    const manager = new BranchManager(branchesFile);
    expect(manager.branchFromCheckpoint("missing")).toBeNull();
    expect(manager.switchBranch("missing")).toBeNull();
  });

  it("handles corrupted persisted JSON gracefully", () => {
    fs.mkdirSync(path.dirname(branchesFile), { recursive: true });
    fs.writeFileSync(branchesFile, "{invalid");

    const manager = new BranchManager(branchesFile);
    expect(manager.listBranches().branches[0].name).toBe("main");
  });
});
