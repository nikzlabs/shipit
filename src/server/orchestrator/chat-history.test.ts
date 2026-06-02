import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";

describe("ChatHistoryManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("returns an empty array for a session with no history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    expect(mgr.load("nonexistent")).toEqual([]);
  });

  it("appends and loads messages for a session", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const userMsg: PersistedMessage = { role: "user", text: "Hello" };
    const assistantMsg: PersistedMessage = { role: "assistant", text: "Hi there!" };

    mgr.append("sess-1", userMsg);
    mgr.append("sess-1", assistantMsg);

    const messages = mgr.load("sess-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(userMsg);
    expect(messages[1]).toEqual(assistantMsg);
  });

  it("persists messages across manager instances", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "Test" });

    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe("Test");
  });

  it("keeps sessions isolated from each other", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "Session 1" });
    mgr.append("sess-2", { role: "user", text: "Session 2" });

    expect(mgr.load("sess-1")).toHaveLength(1);
    expect(mgr.load("sess-1")[0].text).toBe("Session 1");
    expect(mgr.load("sess-2")).toHaveLength(1);
    expect(mgr.load("sess-2")[0].text).toBe("Session 2");
  });

  it("persists tool use blocks", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "I'll edit that file.",
      toolUse: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Edit",
          input: { file_path: "/workspace/app.ts", old_string: "x", new_string: "y" },
        },
      ],
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].toolUse).toHaveLength(1);
    expect(loaded[0].toolUse![0].name).toBe("Edit");
  });

  it("persists a voice-note card so it survives a reload (docs/163)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      voiceNote: {
        id: "voice-1",
        headline: "Done — want me to open a PR?",
        needsAttention: true,
        kind: "authored",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].voiceNote).toEqual(msg.voiceNote);
  });

  it("persists error messages with isError flag", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "assistant", text: "Error: something broke", isError: true });

    const loaded = mgr.load("sess-1");
    expect(loaded[0].isError).toBe(true);
  });

  it("deletes a session's history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "To delete" });

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.load("sess-1")).toEqual([]);
  });

  it("returns false when deleting nonexistent session", () => {
    const mgr = new ChatHistoryManager(dbManager);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("lists session IDs that have stored history", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-a", { role: "user", text: "A" });
    mgr.append("sess-b", { role: "user", text: "B" });

    const ids = mgr.listSessions();
    expect(ids).toContain("sess-a");
    expect(ids).toContain("sess-b");
    expect(ids).toHaveLength(2);
  });

  it("loads persisted history across manager instances", () => {
    const mgr1 = new ChatHistoryManager(dbManager);
    mgr1.append("sess-1", { role: "user", text: "Persisted" });

    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe("Persisted");
  });

  it("persists subagent events for Task tool transparency (109)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "Spawning subagent...",
      toolUse: [
        {
          type: "tool_use",
          id: "task-1",
          name: "Task",
          input: { description: "Audit", prompt: "Audit the codebase." },
        },
      ],
      toolResults: [{ toolUseId: "task-1", content: "## Report\n\nDone." }],
      subagentEvents: [
        {
          kind: "assistant",
          parentToolUseId: "task-1",
          text: "Reading...",
          toolUse: [
            { type: "tool_use", id: "sub-r1", name: "Read", input: { file_path: "/a.ts" } },
          ],
        },
        {
          kind: "tool_result",
          parentToolUseId: "task-1",
          toolResults: [{ toolUseId: "sub-r1", content: "file contents" }],
        },
      ],
    };

    mgr.append("sess-1", msg);

    // Reload via a fresh instance to confirm round-trip serialization works.
    const mgr2 = new ChatHistoryManager(dbManager);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].subagentEvents).toHaveLength(2);
    expect(loaded[0].subagentEvents![0].kind).toBe("assistant");
    expect(loaded[0].subagentEvents![0].parentToolUseId).toBe("task-1");
    expect(loaded[0].subagentEvents![1].kind).toBe("tool_result");
  });

  describe("updateLastMessage", () => {
    it("merges fields into the last finalized message", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "assistant", text: "Done" });

      const updatedId = mgr.updateLastMessage("sess-1", { commitHash: "abc123" });

      expect(updatedId).not.toBeNull();
      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Done");
      expect(messages[0].commitHash).toBe("abc123");
    });

    it("updates only the last message when multiple exist", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Hello" });
      mgr.append("sess-1", { role: "assistant", text: "Hi" });

      mgr.updateLastMessage("sess-1", { text: "Updated hi" });

      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe("Hello");
      expect(messages[1].text).toBe("Updated hi");
    });

    it("skips in-progress rows so postTurnCommit doesn't stamp commit info on a stale next-turn row", () => {
      // Regression: the previous behavior selected the absolute last row by id.
      // If the next turn had already inserted in_progress=1 rows when
      // postTurnCommit ran, the commit_hash got stamped on one of those
      // transient rows — and the next replaceInProgress wiped it. The result
      // was an "0 files" rewind preview for a turn that genuinely committed.
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "first" });
      mgr.append("sess-1", { role: "assistant", text: "finalized answer" });
      // Next turn has begun and persisted an in-progress placeholder.
      mgr.append("sess-1", { role: "assistant", text: "next turn streaming...", inProgress: true });

      const updatedId = mgr.updateLastMessage("sess-1", { commitHash: "deadbeef" });

      expect(updatedId).not.toBeNull();
      const messages = mgr.load("sess-1");
      const finalized = messages.find((m) => m.text === "finalized answer");
      const transient = messages.find((m) => m.text === "next turn streaming...");
      expect(finalized?.commitHash).toBe("deadbeef");
      expect(transient?.commitHash).toBeUndefined();
    });

    it("is a no-op for an empty session", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const id = mgr.updateLastMessage("nonexistent", { text: "ghost" });
      expect(id).toBeNull();
      expect(mgr.load("nonexistent")).toEqual([]);
    });
  });

  describe("truncate", () => {
    it("keeps only the first N messages", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "A" });
      mgr.append("sess-1", { role: "assistant", text: "B" });
      mgr.append("sess-1", { role: "user", text: "C" });
      mgr.append("sess-1", { role: "assistant", text: "D" });

      const kept = mgr.truncate("sess-1", 2);
      expect(kept).toHaveLength(2);
      expect(kept[0].text).toBe("A");
      expect(kept[1].text).toBe("B");

      // Verify persisted state
      const loaded = mgr.load("sess-1");
      expect(loaded).toHaveLength(2);
    });

    it("returns all messages when count exceeds total", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Only one" });

      const kept = mgr.truncate("sess-1", 10);
      expect(kept).toHaveLength(1);
      expect(kept[0].text).toBe("Only one");
    });

    it("returns empty for a session with no messages", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const kept = mgr.truncate("nonexistent", 5);
      expect(kept).toEqual([]);
    });
  });

  describe("transaction error propagation", () => {
    it("saveMessages rolls back on error and preserves original data", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "Original" });

      // Corrupt the insert statement to force an error mid-transaction
      const internal = mgr as any;
      const origRun = internal.stmtInsert.run;
      let callCount = 0;
      vi.spyOn(internal.stmtInsert, "run").mockImplementation(function (this: unknown, ...args: unknown[]) {
        callCount++;
        if (callCount === 2) throw new Error("Simulated DB error");
        return origRun.apply(this, args);
      });

      // saveMessages: deletes existing + inserts new → error on 2nd insert should roll back
      expect(() =>
        mgr.saveMessages("sess-1", [
          { role: "user", text: "New A" },
          { role: "assistant", text: "New B" },
        ]),
      ).toThrow("Simulated DB error");

      vi.restoreAllMocks();

      // Original data should be intact (transaction rolled back the delete + first insert)
      const messages = mgr.load("sess-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe("Original");
    });
  });
});
