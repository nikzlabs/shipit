import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { UsageManager } from "./usage.js";
import { deleteSession } from "./services/session.js";

describe("SessionManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("starts with an empty list when no sessions exist", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.list()).toEqual([]);
  });

  it("tracks a new session", () => {
    const mgr = new SessionManager(dbManager);
    const session = mgr.track("sess-1", "My first session");

    expect(session.id).toBe("sess-1");
    expect(session.title).toBe("My first session");
    expect(session.createdAt).toBeTruthy();
    expect(session.lastUsedAt).toBeTruthy();
  });

  it("updates lastUsedAt and title when tracking an existing session", () => {
    const mgr = new SessionManager(dbManager);
    const original = mgr.track("sess-1", "Original title");

    const updated = mgr.track("sess-1", "Updated title");
    expect(updated.id).toBe("sess-1");
    expect(updated.title).toBe("Updated title");
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.lastUsedAt).toBeTruthy();
  });

  it("uses default title when none provided", () => {
    const mgr = new SessionManager(dbManager);
    const session = mgr.track("sess-1");
    expect(session.title).toBe("New session");
  });

  it("does not overwrite title with undefined on re-track", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Keep this title");
    const updated = mgr.track("sess-1");
    expect(updated.title).toBe("Keep this title");
  });

  it("lists sessions sorted by lastUsedAt (most recent first)", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("old", "Old session");
    mgr.track("new", "New session");

    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("new");
    expect(list[1].id).toBe("old");
  });

  it("deletes a session by id", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "To delete");
    mgr.track("sess-2", "To keep");

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].id).toBe("sess-2");
  });

  it("returns false when deleting a non-existent session", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("persists sessions across manager instances", () => {
    const mgr1 = new SessionManager(dbManager);
    mgr1.track("sess-1", "Persisted");

    const mgr2 = new SessionManager(dbManager);
    const list = mgr2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");
    expect(list[0].title).toBe("Persisted");
  });

  it("renames a session by id", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1", "Original");
    const renamed = mgr.rename("sess-1", "Renamed");
    expect(renamed).not.toBeNull();
    expect(renamed!.id).toBe("sess-1");
    expect(renamed!.title).toBe("Renamed");

    const mgr2 = new SessionManager(dbManager);
    expect(mgr2.list()[0].title).toBe("Renamed");
  });

  it("returns null when renaming a non-existent session", () => {
    const mgr = new SessionManager(dbManager);
    expect(mgr.rename("nonexistent", "New name")).toBeNull();
  });

  it("list() returns independent copies", () => {
    const mgr = new SessionManager(dbManager);
    mgr.track("sess-1");
    const list = mgr.list();
    list.push({ id: "fake", title: "fake", createdAt: "", lastUsedAt: "", remoteUrl: "" });
    expect(mgr.list()).toHaveLength(1);
  });

  describe("markStarted", () => {
    it("resets createdAt to the current time", async () => {
      const mgr = new SessionManager(dbManager);
      const original = mgr.track("sess-1", "Warm session");
      // Wait long enough to guarantee a different ISO timestamp.
      await new Promise((r) => setTimeout(r, 5));
      mgr.markStarted("sess-1");
      const updated = mgr.get("sess-1")!;
      expect(updated.createdAt > original.createdAt).toBe(true);
      expect(updated.lastUsedAt > original.lastUsedAt).toBe(true);
    });

    it("is a no-op for unknown ids", () => {
      const mgr = new SessionManager(dbManager);
      // Should not throw or insert anything.
      mgr.markStarted("nonexistent");
      expect(mgr.list()).toEqual([]);
    });
  });

  describe("findUngraduatedWarm", () => {
    it("finds a warm session by remote URL", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm session");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/repo.git");

      const found = mgr.findUngraduatedWarm("https://github.com/user/repo.git");
      expect(found).toBeDefined();
      expect(found!.id).toBe("warm-1");
      expect(found!.warm).toBe(true);
    });

    it("returns undefined when no warm session matches", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("normal-1", "Normal");
      mgr.setRemoteUrl("normal-1", "https://github.com/user/repo.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git")).toBeUndefined();
    });

    it("excludes the specified session ID", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm 1");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/repo.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git", "warm-1")).toBeUndefined();
    });

    it("does not match warm sessions for a different repo", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("warm-1", "Warm 1");
      mgr.setWarm("warm-1", true);
      mgr.setRemoteUrl("warm-1", "https://github.com/user/other.git");

      expect(mgr.findUngraduatedWarm("https://github.com/user/repo.git")).toBeUndefined();
    });
  });

  describe("PR status snapshot", () => {
    function makeStatus(overrides: Partial<{
      sessionId: string;
      prNumber: number;
      prState: "open" | "merged" | "closed";
    }> = {}) {
      return {
        sessionId: overrides.sessionId ?? "sess-1",
        prNumber: overrides.prNumber ?? 42,
        prUrl: "https://github.com/o/r/pull/42",
        prTitle: "Add thing",
        prState: overrides.prState ?? "open",
        baseBranch: "main",
        headBranch: "shipit/feature",
        insertions: 10,
        deletions: 2,
        checks: { state: "success" as const, total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: "mergeable" as const,
        autoMergeEnabled: false,
      };
    }

    it("persists and retrieves a PR status snapshot", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus());

      const all = mgr.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prNumber: 42, prState: "open" });
    });

    it("retains the snapshot after archiving", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus({ prState: "merged" }));

      mgr.archive("sess-1");

      // Active list excludes archived sessions, but the snapshot survives
      expect(mgr.list()).toHaveLength(0);
      const all = mgr.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prState: "merged" });
    });

    it("clears the snapshot when set to null", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus());
      mgr.setPrStatus("sess-1", null);

      expect(mgr.getAllPrStatuses()).toEqual([]);
    });

    it("survives a manager restart (DB round-trip)", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      mgr.setPrStatus("sess-1", makeStatus({ prState: "merged" }));

      const mgr2 = new SessionManager(dbManager);
      const all = mgr2.getAllPrStatuses();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ sessionId: "sess-1", prState: "merged" });
    });

    it("ignores corrupt JSON without crashing", () => {
      const mgr = new SessionManager(dbManager);
      mgr.track("sess-1", "Test");
      // Bypass the typed setter to inject malformed JSON
      dbManager.db.prepare("UPDATE sessions SET pr_status = ? WHERE id = ?").run("{not-json", "sess-1");
      expect(() => mgr.getAllPrStatuses()).not.toThrow();
      expect(mgr.getAllPrStatuses()).toEqual([]);
    });
  });

  describe("session deletion cascade", () => {
    it("deleteSession cascades to chat history and usage", () => {
      const sessions = new SessionManager(dbManager);
      const chat = new ChatHistoryManager(dbManager);
      const usage = new UsageManager(dbManager);

      sessions.track("sess-1", "Test");
      chat.append("sess-1", { role: "user", text: "Hello" });
      usage.record("sess-1", 0.05, 3000);

      const deleted = deleteSession(sessions, "sess-1", chat, usage);

      expect(deleted).toBe(true);
      expect(sessions.get("sess-1")).toBeUndefined();
      expect(chat.load("sess-1")).toEqual([]);
      expect(usage.getSessionUsage("sess-1")).toBeUndefined();
    });

    it("deleteSession returns false for nonexistent session without touching stores", () => {
      const sessions = new SessionManager(dbManager);
      const chat = new ChatHistoryManager(dbManager);
      const usage = new UsageManager(dbManager);

      // Add data for a different session
      sessions.track("sess-2", "Keep");
      chat.append("sess-2", { role: "user", text: "Kept" });
      usage.record("sess-2", 0.10, 5000);

      const deleted = deleteSession(sessions, "nonexistent", chat, usage);

      expect(deleted).toBe(false);
      // Other session data untouched
      expect(chat.load("sess-2")).toHaveLength(1);
      expect(usage.getSessionUsage("sess-2")).toBeDefined();
    });
  });
});
