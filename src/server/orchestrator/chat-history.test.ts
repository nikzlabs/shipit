import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
