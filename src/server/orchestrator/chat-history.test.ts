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

  it("persists a compaction card so it survives a reload (docs/179)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      compaction: {
        id: "compaction-1",
        trigger: "manual",
        preTokens: 180_000,
        postTokens: 42_000,
        durationMs: 3200,
        createdAt: "2026-06-06T00:00:00.000Z",
      },
    };

    mgr.append("sess-1", msg);
    const loaded = mgr.load("sess-1");
    expect(loaded[0].compaction).toEqual(msg.compaction);
  });

  it("persists a bare compaction card (Codex supplies no detail fields)", () => {
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "",
      compaction: { id: "compaction-2", createdAt: "2026-06-06T00:00:00.000Z" },
    };
    mgr.append("sess-1", msg);
    expect(mgr.load("sess-1")[0].compaction).toEqual(msg.compaction);
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

  describe("bug-report card persistence (docs/164)", () => {
    const draftCard = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      bugReport: {
        cardId,
        phase: "draft",
        title: "Preview won't reload",
        body: "redacted body",
        stage2Ran: false,
        producer: "session",
        filedAs: "octocat",
        createdAt: "2026-06-03T00:00:00.000Z",
      },
    });

    it("(a) persists a bug-report card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = draftCard("bug-card-1");
      mgr.append("sess-1", msg);

      // A fresh manager (mirrors a reload rebuilding from the DB) sees the card.
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].bugReport).toEqual(msg.bugReport);
    });

    it("(b) updateBugReportCard flips a card to filed with its issue link", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "report this" });
      mgr.append("sess-1", draftCard("bug-card-1"));

      const found = mgr.updateBugReportCard("sess-1", "bug-card-1", {
        phase: "filed",
        issueNumber: 1234,
        issueUrl: "https://github.com/nicolasalt/shipit/issues/1234",
      });
      expect(found).toBe(true);

      const card = mgr.load("sess-1")[1].bugReport;
      expect(card?.phase).toBe("filed");
      expect(card?.issueNumber).toBe(1234);
      expect(card?.issueUrl).toContain("issues/1234");
      // Original draft fields are preserved through the merge.
      expect(card?.title).toBe("Preview won't reload");
    });

    it("(d) updateBugReportCard records a failure as an editable draft", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", draftCard("bug-card-1"));

      mgr.updateBugReportCard("sess-1", "bug-card-1", {
        phase: "draft",
        errorMessage: "Your GitHub token can't file issues. Reconnect GitHub.",
        scopeError: true,
      });

      const card = mgr.load("sess-1")[0].bugReport;
      expect(card?.phase).toBe("draft");
      expect(card?.scopeError).toBe(true);
      expect(card?.errorMessage).toContain("Reconnect GitHub");
    });

    it("returns false when no card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", draftCard("bug-card-1"));
      expect(mgr.updateBugReportCard("sess-1", "missing", { phase: "filed" })).toBe(false);
    });
  });

  it("round-trips a message carrying every optional field (serialization contract)", () => {
    // Contract guard: if you add a field to PersistedMessage, wire it through
    // toRow/fromRow (and a migration) AND add it here. A field that serializes
    // one way but not the other — the recurring "card renders live but vanishes
    // on reload" bug class — fails this deep-equal.
    const mgr = new ChatHistoryManager(dbManager);
    const msg: PersistedMessage = {
      role: "assistant",
      text: "everything",
      toolUse: [{ type: "tool_use", id: "t1", name: "Edit", input: { path: "a.ts" } }],
      images: [{ data: "abc", mediaType: "image/png" }],
      files: [{ path: "a.ts", contentPreview: "x", startLine: 1, endLine: 2 }],
      isError: true,
      toolResults: [{ toolUseId: "t1", content: "ok", isError: false }],
      commitHash: "abc123",
      parentCommitHash: "def456",
      uploadPaths: ["/uploads/x.png"],
      notice: true,
      noticeLevel: "warn",
      rolledBack: true,
      forkChild: { childSessionId: "child", title: "T", branch: "b" },
      codeRollbackHash: "c0ffee",
      voiceNote: { id: "v1", headline: "h", needsAttention: true, kind: "authored", createdAt: "t" },
      bugReport: { cardId: "b1", phase: "filed", title: "T", body: "B", stage2Ran: true, producer: "ops", issueNumber: 5, issueUrl: "u" },
      compaction: { id: "c1", trigger: "manual", preTokens: 100, postTokens: 20, durationMs: 9, createdAt: "t" },
      issueWrite: {
        cardId: "iw1",
        tracker: "linear",
        issueId: "SHI-28",
        identifier: "SHI-28",
        title: "Some issue",
        url: "https://linear.app/x/issue/SHI-28",
        verb: "status",
        summary: "set SHI-28 → In Review",
        attribution: "workspace",
        undo: { kind: "status", previousStatus: "Todo" },
        undoState: "available",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
      subagentEvents: [],
    };

    mgr.append("sess-1", msg);
    expect(mgr.load("sess-1")[0]).toEqual(msg);
  });

  describe("issue-write card persistence (docs/177)", () => {
    const writeCard = (cardId: string): PersistedMessage => ({
      role: "assistant",
      text: "",
      issueWrite: {
        cardId,
        tracker: "github",
        issueId: "42",
        identifier: "octocat/hello#42",
        title: "Bug",
        url: "https://github.com/octocat/hello/issues/42",
        verb: "comment",
        summary: "commented on octocat/hello#42",
        attribution: "user",
        undo: { kind: "comment", commentId: "c-99" },
        undoState: "available",
        createdAt: "2026-06-05T00:00:00.000Z",
      },
    });

    it("persists a write card so it replays on session attach", () => {
      const mgr = new ChatHistoryManager(dbManager);
      const msg = writeCard("iw-1");
      mgr.append("sess-1", msg);
      const loaded = new ChatHistoryManager(dbManager).load("sess-1");
      expect(loaded[0].issueWrite).toEqual(msg.issueWrite);
    });

    it("findIssueWriteCard recovers the tracker + undo snapshot by id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", { role: "user", text: "comment please" });
      mgr.append("sess-1", writeCard("iw-1"));
      const card = mgr.findIssueWriteCard("sess-1", "iw-1");
      expect(card?.tracker).toBe("github");
      expect(card?.undo).toEqual({ kind: "comment", commentId: "c-99" });
      expect(mgr.findIssueWriteCard("sess-1", "missing")).toBeNull();
    });

    it("updateIssueWriteCard flips a card to undone in place", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", writeCard("iw-1"));
      expect(mgr.updateIssueWriteCard("sess-1", "iw-1", { undoState: "undone" })).toBe(true);
      const card = mgr.load("sess-1")[0].issueWrite;
      expect(card?.undoState).toBe("undone");
      // Original fields survive the merge.
      expect(card?.summary).toBe("commented on octocat/hello#42");
    });

    it("returns false when no write card matches the given id", () => {
      const mgr = new ChatHistoryManager(dbManager);
      mgr.append("sess-1", writeCard("iw-1"));
      expect(mgr.updateIssueWriteCard("sess-1", "missing", { undoState: "undone" })).toBe(false);
    });
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
