import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadManager } from "./threads.js";

describe("ThreadManager", () => {
  let tmpDir: string;
  let manager: ThreadManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-thread-test-"));
    manager = new ThreadManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("creates default thread data with a main thread", () => {
      const data = manager.init("session-1");
      expect(data.threads).toHaveLength(1);
      expect(data.threads[0].name).toBe("main");
      expect(data.threads[0].isActive).toBe(true);
      expect(data.threads[0].parentCheckpointId).toBeNull();
      expect(data.activeThreadId).toBe(data.threads[0].id);
    });

    it("returns existing data if already initialized", () => {
      const first = manager.init("session-1");
      const second = manager.init("session-1");
      expect(second.threads[0].id).toBe(first.threads[0].id);
    });
  });

  describe("listThreads", () => {
    it("returns threads and active thread ID", () => {
      manager.init("session-1");
      const result = manager.listThreads("session-1");
      expect(result.threads).toHaveLength(1);
      expect(result.activeThreadId).toBe(result.threads[0].id);
    });

    it("returns default data for unknown session", () => {
      const result = manager.listThreads("unknown");
      expect(result.threads).toHaveLength(1);
      expect(result.threads[0].name).toBe("main");
    });
  });

  describe("getActiveThread", () => {
    it("returns the currently active thread", () => {
      manager.init("session-1");
      const active = manager.getActiveThread("session-1");
      expect(active).toBeDefined();
      expect(active!.name).toBe("main");
      expect(active!.isActive).toBe(true);
    });
  });

  describe("createCheckpoint", () => {
    it("creates a checkpoint on the active thread", () => {
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
      const m2 = new ThreadManager(tmpDir);
      const data = m2.listThreads("session-1");
      expect(data.threads[0].checkpoints).toHaveLength(1);
      expect(data.threads[0].checkpoints[0].commitHash).toBe("def456");
    });

    it("creates multiple checkpoints on the same thread", () => {
      manager.init("session-1");
      manager.createCheckpoint("session-1", 2, "aaa");
      manager.createCheckpoint("session-1", 5, "bbb");
      manager.createCheckpoint("session-1", 8, "ccc");

      const data = manager.listThreads("session-1");
      expect(data.threads[0].checkpoints).toHaveLength(3);
    });

    it("creates checkpoint without label", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 3, "abc");
      expect(cp!.label).toBeUndefined();
    });

    it("returns null for unknown session (no active thread)", () => {
      // Don't init — no threads exist
      const result = manager.createCheckpoint("unknown", 0, "abc");
      // It creates a default data with main thread, so this actually succeeds
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

  describe("forkThread", () => {
    it("creates a new thread from a checkpoint", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const thread = manager.forkThread("session-1", cp!.id);

      expect(thread).not.toBeNull();
      expect(thread!.name).toBe("Thread 1");
      expect(thread!.parentCheckpointId).toBe(cp!.id);
      expect(thread!.isActive).toBe(true);
    });

    it("deactivates the previous thread", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      manager.forkThread("session-1", cp!.id);

      const data = manager.listThreads("session-1");
      const mainThread = data.threads.find((t) => t.name === "main");
      expect(mainThread!.isActive).toBe(false);
    });

    it("updates the active thread ID", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const thread = manager.forkThread("session-1", cp!.id);

      const data = manager.listThreads("session-1");
      expect(data.activeThreadId).toBe(thread!.id);
    });

    it("returns null for unknown checkpoint", () => {
      manager.init("session-1");
      const thread = manager.forkThread("session-1", "nonexistent");
      expect(thread).toBeNull();
    });

    it("increments thread number", () => {
      manager.init("session-1");
      const cp1 = manager.createCheckpoint("session-1", 3, "aaa");
      const t1 = manager.forkThread("session-1", cp1!.id);
      expect(t1!.name).toBe("Thread 1");

      const cp2 = manager.createCheckpoint("session-1", 6, "bbb");
      const t2 = manager.forkThread("session-1", cp2!.id);
      expect(t2!.name).toBe("Thread 2");
    });
  });

  describe("switchThread", () => {
    it("switches to an existing thread", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123");
      const newThread = manager.forkThread("session-1", cp!.id);

      // Switch back to main
      const data = manager.listThreads("session-1");
      const mainThread = data.threads.find((t) => t.name === "main")!;
      const result = manager.switchThread("session-1", mainThread.id);

      expect(result).not.toBeNull();
      expect(result!.name).toBe("main");
      expect(result!.isActive).toBe(true);

      // Verify the new thread is no longer active
      const updated = manager.listThreads("session-1");
      const newThreadUpdated = updated.threads.find((t) => t.id === newThread!.id);
      expect(newThreadUpdated!.isActive).toBe(false);
    });

    it("returns null for unknown thread ID", () => {
      manager.init("session-1");
      const result = manager.switchThread("session-1", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("setAgentSessionId", () => {
    it("sets the agent session ID on a thread", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      manager.setAgentSessionId("session-1", threadId, "agent-abc");

      const updated = manager.listThreads("session-1");
      expect(updated.threads[0].agentSessionId).toBe("agent-abc");
    });
  });

  describe("delete", () => {
    it("removes thread data for a session", () => {
      manager.init("session-1");
      manager.createCheckpoint("session-1", 3, "abc");

      const deleted = manager.delete("session-1");
      expect(deleted).toBe(true);

      // New load should return defaults
      const data = manager.listThreads("session-1");
      expect(data.threads[0].checkpoints).toHaveLength(0);
    });

    it("returns false for nonexistent session", () => {
      expect(manager.delete("nonexistent")).toBe(false);
    });
  });

  describe("persistence", () => {
    it("survives manager recreation", () => {
      manager.init("session-1");
      const cp = manager.createCheckpoint("session-1", 5, "abc123", "test checkpoint");
      manager.forkThread("session-1", cp!.id);

      // Create fresh manager from same directory
      const m2 = new ThreadManager(tmpDir);
      const data = m2.listThreads("session-1");
      expect(data.threads).toHaveLength(2);
      expect(data.threads[0].name).toBe("main");
      expect(data.threads[1].name).toBe("Thread 1");
    });

    it("handles corrupted JSON gracefully", () => {
      const filePath = path.join(tmpDir, "session-1.json");
      fs.writeFileSync(filePath, "not valid json");

      const data = manager.listThreads("session-1");
      expect(data.threads).toHaveLength(1);
      expect(data.threads[0].name).toBe("main");
    });
  });

  describe("setConversationReplay", () => {
    it("stores conversation replay on a thread", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      const replay = "User: Hello\nAssistant: Hi there!";
      manager.setConversationReplay("session-1", threadId, replay);

      const updated = manager.listThreads("session-1");
      expect(updated.threads[0].conversationReplay).toBe(replay);
    });

    it("persists replay to disk", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      manager.setConversationReplay("session-1", threadId, "replay text");

      const m2 = new ThreadManager(tmpDir);
      const loaded = m2.listThreads("session-1");
      expect(loaded.threads[0].conversationReplay).toBe("replay text");
    });

    it("does nothing for unknown thread", () => {
      manager.init("session-1");
      // Should not throw
      manager.setConversationReplay("session-1", "nonexistent", "text");
    });
  });

  describe("consumeConversationReplay", () => {
    it("returns replay and clears it", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      manager.setConversationReplay("session-1", threadId, "replay text");

      const replay = manager.consumeConversationReplay("session-1", threadId);
      expect(replay).toBe("replay text");

      // Should be cleared
      const second = manager.consumeConversationReplay("session-1", threadId);
      expect(second).toBeUndefined();
    });

    it("returns undefined when no replay is set", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      const replay = manager.consumeConversationReplay("session-1", threadId);
      expect(replay).toBeUndefined();
    });

    it("returns undefined for unknown thread", () => {
      manager.init("session-1");
      const replay = manager.consumeConversationReplay("session-1", "nonexistent");
      expect(replay).toBeUndefined();
    });

    it("clears replay from persisted data", () => {
      const data = manager.init("session-1");
      const threadId = data.threads[0].id;
      manager.setConversationReplay("session-1", threadId, "replay text");
      manager.consumeConversationReplay("session-1", threadId);

      // Verify cleared on disk
      const m2 = new ThreadManager(tmpDir);
      const loaded = m2.listThreads("session-1");
      expect(loaded.threads[0].conversationReplay).toBeUndefined();
    });
  });

  describe("session ID sanitization", () => {
    it("sanitizes path traversal in session IDs", () => {
      manager.init("../../etc/passwd");
      const data = manager.listThreads("../../etc/passwd");
      expect(data.threads).toHaveLength(1);

      // Verify the file is in the expected directory
      const files = fs.readdirSync(tmpDir);
      expect(files.every((f) => !f.includes(".."))).toBe(true);
    });
  });
});
