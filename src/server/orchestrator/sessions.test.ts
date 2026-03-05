import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";

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
    list.push({ id: "fake", title: "fake", createdAt: "", lastUsedAt: "" });
    expect(mgr.list()).toHaveLength(1);
  });
});
