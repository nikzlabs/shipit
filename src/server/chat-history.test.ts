import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";

describe("ChatHistoryManager", () => {
  let tmpDir: string;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-history-test-"));
    historyDir = path.join(tmpDir, "chat-history");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array for a session with no history", () => {
    const mgr = new ChatHistoryManager(historyDir);
    expect(mgr.load("nonexistent")).toEqual([]);
  });

  it("appends and loads messages for a session", () => {
    const mgr = new ChatHistoryManager(historyDir);
    const userMsg: PersistedMessage = { role: "user", text: "Hello" };
    const assistantMsg: PersistedMessage = { role: "assistant", text: "Hi there!" };

    mgr.append("sess-1", userMsg);
    mgr.append("sess-1", assistantMsg);

    const messages = mgr.load("sess-1");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(userMsg);
    expect(messages[1]).toEqual(assistantMsg);
  });

  it("persists messages to disk", () => {
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("sess-1", { role: "user", text: "Test" });

    // Verify file exists on disk
    const filePath = path.join(historyDir, "sess-1.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].text).toBe("Test");
  });

  it("keeps sessions isolated from each other", () => {
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("sess-1", { role: "user", text: "Session 1" });
    mgr.append("sess-2", { role: "user", text: "Session 2" });

    expect(mgr.load("sess-1")).toHaveLength(1);
    expect(mgr.load("sess-1")[0].text).toBe("Session 1");
    expect(mgr.load("sess-2")).toHaveLength(1);
    expect(mgr.load("sess-2")[0].text).toBe("Session 2");
  });

  it("persists tool use blocks", () => {
    const mgr = new ChatHistoryManager(historyDir);
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
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("sess-1", { role: "assistant", text: "Error: something broke", isError: true });

    const loaded = mgr.load("sess-1");
    expect(loaded[0].isError).toBe(true);
  });

  it("deletes a session's history", () => {
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("sess-1", { role: "user", text: "To delete" });

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.load("sess-1")).toEqual([]);
  });

  it("returns false when deleting nonexistent session", () => {
    const mgr = new ChatHistoryManager(historyDir);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("lists session IDs that have stored history", () => {
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("sess-a", { role: "user", text: "A" });
    mgr.append("sess-b", { role: "user", text: "B" });

    const ids = mgr.listSessions();
    expect(ids).toContain("sess-a");
    expect(ids).toContain("sess-b");
    expect(ids).toHaveLength(2);
  });

  it("handles corrupted history file gracefully", () => {
    const mgr = new ChatHistoryManager(historyDir);
    // Create the directory and write a corrupt file
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, "corrupt.json"), "not valid json!!!");

    expect(mgr.load("corrupt")).toEqual([]);
  });

  it("loads persisted history across manager instances", () => {
    const mgr1 = new ChatHistoryManager(historyDir);
    mgr1.append("sess-1", { role: "user", text: "Persisted" });

    const mgr2 = new ChatHistoryManager(historyDir);
    const loaded = mgr2.load("sess-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe("Persisted");
  });

  it("sanitizes session IDs to prevent path traversal", () => {
    const mgr = new ChatHistoryManager(historyDir);
    mgr.append("../../../etc/passwd", { role: "user", text: "sneaky" });

    // Should be saved safely inside the history dir, not at a traversal path
    const loaded = mgr.load("../../../etc/passwd");
    expect(loaded).toHaveLength(1);

    // No file should exist outside the history dir
    expect(fs.existsSync("/etc/passwd.json")).toBe(false);
  });

  it("creates the history directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "deeply", "nested", "history");
    const mgr = new ChatHistoryManager(nestedDir);
    mgr.append("sess-1", { role: "user", text: "test" });

    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(mgr.load("sess-1")).toHaveLength(1);
  });
});
