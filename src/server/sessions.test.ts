import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "./sessions.js";

describe("SessionManager", () => {
  let tmpDir: string;
  let sessionsFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-test-"));
    sessionsFile = path.join(tmpDir, ".vibe-sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with an empty list when no file exists", () => {
    const mgr = new SessionManager(sessionsFile);
    expect(mgr.list()).toEqual([]);
  });

  it("tracks a new session and persists it to disk", () => {
    const mgr = new SessionManager(sessionsFile);
    const session = mgr.track("sess-1", "My first session");

    expect(session.id).toBe("sess-1");
    expect(session.title).toBe("My first session");
    expect(session.createdAt).toBeTruthy();
    expect(session.lastUsedAt).toBeTruthy();

    // Verify persisted
    const raw = JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe("sess-1");
  });

  it("updates lastUsedAt and title when tracking an existing session", () => {
    const mgr = new SessionManager(sessionsFile);
    const original = mgr.track("sess-1", "Original title");

    // Track again with new title
    const updated = mgr.track("sess-1", "Updated title");
    expect(updated.id).toBe("sess-1");
    expect(updated.title).toBe("Updated title");
    expect(updated.createdAt).toBe(original.createdAt);
    // lastUsedAt should be updated (or same if called immediately)
    expect(updated.lastUsedAt).toBeTruthy();
  });

  it("uses default title when none provided", () => {
    const mgr = new SessionManager(sessionsFile);
    const session = mgr.track("sess-1");
    expect(session.title).toBe("New session");
  });

  it("does not overwrite title with undefined on re-track", () => {
    const mgr = new SessionManager(sessionsFile);
    mgr.track("sess-1", "Keep this title");
    const updated = mgr.track("sess-1");
    expect(updated.title).toBe("Keep this title");
  });

  it("lists sessions sorted by lastUsedAt (most recent first)", () => {
    const mgr = new SessionManager(sessionsFile);
    mgr.track("old", "Old session");
    // Small delay to ensure different timestamps
    mgr.track("new", "New session");

    const list = mgr.list();
    expect(list).toHaveLength(2);
    // Most recently tracked should be first
    expect(list[0].id).toBe("new");
    expect(list[1].id).toBe("old");
  });

  it("deletes a session by id", () => {
    const mgr = new SessionManager(sessionsFile);
    mgr.track("sess-1", "To delete");
    mgr.track("sess-2", "To keep");

    const deleted = mgr.delete("sess-1");
    expect(deleted).toBe(true);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0].id).toBe("sess-2");
  });

  it("returns false when deleting a non-existent session", () => {
    const mgr = new SessionManager(sessionsFile);
    expect(mgr.delete("nonexistent")).toBe(false);
  });

  it("loads persisted sessions on construction", () => {
    // Create and populate with first instance
    const mgr1 = new SessionManager(sessionsFile);
    mgr1.track("sess-1", "Persisted");

    // Create second instance pointing to same file
    const mgr2 = new SessionManager(sessionsFile);
    const list = mgr2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");
    expect(list[0].title).toBe("Persisted");
  });

  it("handles corrupted sessions file gracefully", () => {
    fs.writeFileSync(sessionsFile, "not valid json!!!");
    const mgr = new SessionManager(sessionsFile);
    expect(mgr.list()).toEqual([]);
  });

  it("returns a copy from list() (not the internal array)", () => {
    const mgr = new SessionManager(sessionsFile);
    mgr.track("sess-1");
    const list = mgr.list();
    list.push({ id: "fake", title: "fake", createdAt: "", lastUsedAt: "" });
    // Internal state should not be affected
    expect(mgr.list()).toHaveLength(1);
  });
});
