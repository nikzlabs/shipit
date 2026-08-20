/**
 * docs/277 — muting a session.
 *
 * Two things are worth pinning here, because both are rules a caller could
 * plausibly get wrong: the mute is stored on the session (req 7), and a session
 * whose agent is working cannot be muted (req 6) while unmuting is never gated.
 */

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
    // Read back from the DB, not the returned object: the value has to survive a
    // reload and reach a second device (req 7).
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
    // A mute that could not be lifted because a turn started would outlive the
    // state that justified it.
    expect(() => setSessionMuted(sessionManager, "a", false, true)).not.toThrow();
    expect(sessionManager.get("a")?.mutedAt).toBeUndefined();
  });

  it("is idempotent rather than a 404 when the state already matches", () => {
    // `SessionManager.setMuted` returns null both for "no such session" and "no
    // change"; the service must not read the second as the first.
    const first = setSessionMuted(sessionManager, "a", true, false).session.mutedAt;
    const again = setSessionMuted(sessionManager, "a", true, false).session;
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
