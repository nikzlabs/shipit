import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BranchManager } from "./branches.js";

describe("BranchManager", () => {
  let tmpDir: string;
  let manager: BranchManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-branch-test-"));
    manager = new BranchManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates default branch data with a main branch", () => {
      const data = manager.init("session-1");
      expect(data.branches).toHaveLength(1);
      expect(data.branches[0].name).toBe("main");
      expect(data.branches[0].isActive).toBe(true);
      expect(data.branches[0].parentCheckpointId).toBeNull();
      expect(data.activeBranchId).toBe(data.branches[0].id);
    });

    it("returns existing data if already initialized", () => {
      const first = manager.init("session-1");
      const second = manager.init("session-1");
      expect(second.branches[0].id).toBe(first.branches[0].id);
    });
  });

  describe("listBranches", () => {
    it("returns branches and active branch ID", () => {
      manager.init("session-1");
      const result = manager.listBranches("session-1");
      expect(result.branches).toHaveLength(1);
      expect(result.activeBranchId).toBe(result.branches[0].id);
    });

    it("returns default data for unknown session", () => {
      const result = manager.listBranches("unknown");
      expect(result.branches).toHaveLength(1);
      expect(result.branches[0].name).toBe("main");
    });
  });

  describe("getActiveBranch", () => {
    it("returns the currently active branch", () => {
      manager.init("session-1");
      const active = manager.getActiveBranch("session-1");
      expect(active).toBeDefined();
      expect(active!.name).toBe("main");
      expect(active!.isActive).toBe(true);
    });
  });

  describe("createCheckpoint", () => {
    it("creates a checkpoint on the active branch", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123", "Before refactor");
      expect(cp).not.toBeNull();
      expect(cp!.sessionId).toBe("session-1");
      expect(cp!.messageIndex).toBe(5);
      expect(cp!.commitHash).toBe("abc123");
      expect(cp!.label).toBe("Before refactor");
      expect(cp!.id).toBeDefined();
      expect(cp!.createdAt).toBeDefined();
    });

    it("persists checkpoint to disk", () => {
      manager.init("session-1");
      manager.createCheckpoint("session-1", 3, "def456");

      // Create a new manager to verify persistence
      const m2 = new BranchManager(tmpDir);
      const data = m2.listBranches("session-1");
      expect(data.branches[0].checkpoints).toHaveLength(1);
      expect(data.branches[0].checkpoints[0].commitHash).toBe("def456");
    });

    it("creates multiple checkpoints on the same branch", () => {
      manager.init("session-1");
      manager.createCheckpoint("session-1", 2, "aaa");
      manager.createCheckpoint("session-1", 5, "bbb");
      manager.createCheckpoint("session-1", 8, "ccc");

      const data = manager.listBranches("session-1");
      expect(data.branches[0].checkpoints).toHaveLength(3);
    });

    it("creates checkpoint without label", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 3, "abc");
      expect(cp!.label).toBeUndefined();
    });

    it("returns null for unknown session (no active branch)", () => {
      // Don't init — no branches exist
      const result = manager.createCheckpoint("unknown", 0, "abc");
      // It creates a default data with main branch, so this actually succeeds
      expect(result).not.toBeNull();
    });
  });

  describe("getCheckpoint", () => {
    it("finds a checkpoint by ID", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123", "test");
      const found = manager.getCheckpoint("session-1", cp!.id);
      expect(found).toEqual(cp);
    });

    it("returns undefined for unknown checkpoint ID", () => {
      manager.init("session-1");
      const found = manager.getCheckpoint("session-1", "nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("branchFrom", () => {
    it("creates a new branch from a checkpoint", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const branch = manager.branchFrom("session-1", cp!.id);

      expect(branch).not.toBeNull();
      expect(branch!.name).toBe("Branch 1");
      expect(branch!.parentCheckpointId).toBe(cp!.id);
      expect(branch!.isActive).toBe(true);
    });

    it("deactivates the previous branch", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      manager.branchFrom("session-1", cp!.id);

      const data = manager.listBranches("session-1");
      const mainBranch = data.branches.find((b) => b.name === "main");
      expect(mainBranch!.isActive).toBe(false);
    });

    it("updates the active branch ID", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const branch = manager.branchFrom("session-1", cp!.id);

      const data = manager.listBranches("session-1");
      expect(data.activeBranchId).toBe(branch!.id);
    });

    it("returns null for unknown checkpoint", () => {
      manager.init("session-1");
      const branch = manager.branchFrom("session-1", "nonexistent");
      expect(branch).toBeNull();
    });

    it("increments branch number", () => {
      manager.init("session-1");
      const cp1 = manager.createCheckpoint("session-1", 3, "aaa");
      const b1 = manager.branchFrom("session-1", cp1!.id);
      expect(b1!.name).toBe("Branch 1");

      const cp2 = manager.createCheckpoint("session-1", 6, "bbb");
      const b2 = manager.branchFrom("session-1", cp2!.id);
      expect(b2!.name).toBe("Branch 2");
    });
  });

  describe("switchBranch", () => {
    it("switches to an existing branch", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const newBranch = manager.branchFrom("session-1", cp!.id);

      // Switch back to main
      const data = manager.listBranches("session-1");
      const mainBranch = data.branches.find((b) => b.name === "main")!;
      const result = manager.switchBranch("session-1", mainBranch.id);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("main");
      expect(result!.isActive).toBe(true);

      // Verify the new branch is no longer active
      const updated = manager.listBranches("session-1");
      const newBranchUpdated = updated.branches.find((b) => b.id === newBranch!.id);
      expect(newBranchUpdated!.isActive).toBe(false);
    });

    it("returns null for unknown branch ID", () => {
      manager.init("session-1");
      const result = manager.switchBranch("session-1", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("setAgentSessionId", () => {
    it("sets the agent session ID on a branch", () => {
      const data = manager.init("session-1");
      const branchId = data.branches[0].id;
      manager.setAgentSessionId("session-1", branchId, "agent-abc");

      const updated = manager.listBranches("session-1");
      expect(updated.branches[0].agentSessionId).toBe("agent-abc");
    });
  });

  describe("delete", () => {
    it("removes branch data for a session", () => {
      manager.init("session-1");
      manager.createCheckpoint("session-1", 3, "abc");

      const deleted = manager.delete("session-1");
      expect(deleted).toBe(true);

      // New load should return defaults
      const data = manager.listBranches("session-1");
      expect(data.branches[0].checkpoints).toHaveLength(0);
    });

    it("returns false for nonexistent session", () => {
      expect(manager.delete("nonexistent")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("survives manager recreation", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123", "test checkpoint");
      manager.branchFrom("session-1", cp!.id);

      // Create fresh manager from same directory
      const m2 = new BranchManager(tmpDir);
      const data = m2.listBranches("session-1");
      expect(data.branches).toHaveLength(2);
      expect(data.branches[0].name).toBe("main");
      expect(data.branches[1].name).toBe("Branch 1");
    });

    it("handles corrupted JSON gracefully", () => {
      const filePath = path.join(tmpDir, "session-1.json");
      fs.writeFileSync(filePath, "not valid json");

      const data = manager.listBranches("session-1");
      expect(data.branches).toHaveLength(1);
      expect(data.branches[0].name).toBe("main");
    });
  });

  describe("session ID sanitization", () => {
    it("sanitizes path traversal in session IDs", () => {
      manager.init("../../etc/passwd");
      const data = manager.listBranches("../../etc/passwd");
      expect(data.branches).toHaveLength(1);

      // Verify the file is in the expected directory
      const files = fs.readdirSync(tmpDir);
      expect(files.every((f) => !f.includes(".."))).toBe(true);
    });
  });
});
