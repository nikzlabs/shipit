import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setSessionMuted } from "./session.js";
import { SessionManager } from "../sessions.js";
import type { DatabaseManager } from "../../shared/database.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";

let dbManager: DatabaseManager;
let sessionManager: SessionManager;

beforeEach(() => {
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  sessionManager.track("a", "a", "/workspace/a");
});

afterEach(() => {
  dbManager.close();
});

describe("setSessionMuted", () => {
  it("records the mute instant, and clears it on unmute", () => {
    const { session } = setSessionMuted(sessionManager, "a", true, false);
    expect(session.mutedAt).toBeTruthy();
    expect(sessionManager.get("a")?.mutedAt).toBe(session.mutedAt);

    setSessionMuted(sessionManager, "a", false, false);
    expect(sessionManager.get("a")?.mutedAt).toBeUndefined();
  });

  it("refuses to mute a session whose agent is working", () => {
    expect(() => setSessionMuted(sessionManager, "a", true, true)).toThrow(/agent is working/);
    expect(sessionManager.get("a")?.mutedAt).toBeUndefined();
  });

  it("allows unmuting even while the agent is working", () => {
    setSessionMuted(sessionManager, "a", true, false);
    expect(() => setSessionMuted(sessionManager, "a", false, true)).not.toThrow();
    expect(sessionManager.get("a")?.mutedAt).toBeUndefined();
  });

  it("is idempotent rather than a 404 when the state already matches", () => {
    const first = setSessionMuted(sessionManager, "a", true, false, new Date("2026-01-01T00:00:00.000Z"))
      .session.mutedAt;
    const again = setSessionMuted(sessionManager, "a", true, false, new Date("2026-06-01T00:00:00.000Z"))
      .session;
    expect(again.mutedAt).toBe(first);
  });

  it("changes nothing else about the session (req 3)", () => {
    const before = sessionManager.get("a");
    setSessionMuted(sessionManager, "a", true, false);
    const after = sessionManager.get("a");
    expect({ ...after, mutedAt: undefined }).toEqual({ ...before, mutedAt: undefined });
  });

  it("404s on an unknown session", () => {
    expect(() => setSessionMuted(sessionManager, "nope", true, false)).toThrow(/not found/i);
  });
});
