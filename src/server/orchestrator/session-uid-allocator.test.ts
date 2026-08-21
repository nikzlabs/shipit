/**
 * docs/270 — the per-session uid ledger.
 *
 * The properties worth guarding are the two that requirements 6 and 7 turn on:
 * two live sessions never share a number, and a number is never handed out
 * twice even after the session that held it is deleted.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  allocateSessionUid,
  assertSessionUidRange,
  isSessionUid,
  SessionUidExhaustedError,
  SESSION_UID_MAX,
  SESSION_UID_MIN,
} from "./session-uid-allocator.js";
import { RESERVED_EGRESS_UIDS } from "./session-worker-uid.js";

function ledger(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_uid_allocation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_uid INTEGER NOT NULL
    );
  `);
  return db;
}

describe("the reserved range", () => {
  it("excludes both egress-sidecar uids", () => {
    // The netns firewall exempts 911 and 912 by owner-match, so a session
    // allocated one would run exempt from the tier that names it. The range is
    // chosen so this cannot happen; the assertion exists because the constants
    // are editable and the failure would otherwise be silent.
    for (const uid of RESERVED_EGRESS_UIDS) expect(isSessionUid(uid)).toBe(false);
    expect(() => assertSessionUidRange()).not.toThrow();
  });

  it("excludes every uid a real image or project would name", () => {
    // 33 www-data, 101/999 common service accounts, 1000/1001 the conventional
    // first users, 65534 nobody, 100000 the subuid convention's floor. A
    // compose `user:` naming any of these must keep working (req 4).
    for (const uid of [0, 33, 101, 999, 1000, 1001, 65534, 100_000, 165_536]) {
      expect(isSessionUid(uid)).toBe(false);
    }
  });

  it("accepts its own endpoints and nothing past them", () => {
    expect(isSessionUid(SESSION_UID_MIN)).toBe(true);
    expect(isSessionUid(SESSION_UID_MAX)).toBe(true);
    expect(isSessionUid(SESSION_UID_MIN - 1)).toBe(false);
    expect(isSessionUid(SESSION_UID_MAX + 1)).toBe(false);
    expect(isSessionUid(Number.NaN)).toBe(false);
  });
});

describe("allocateSessionUid", () => {
  it("starts at the bottom of the range and never repeats", () => {
    const db = ledger();
    const seen = new Set<number>();
    for (let i = 0; i < 50; i += 1) seen.add(allocateSessionUid(db));
    expect(seen.size).toBe(50);
    expect(Math.min(...seen)).toBe(SESSION_UID_MIN);
    for (const uid of seen) expect(isSessionUid(uid)).toBe(true);
  });

  it("does not reuse an identity after its session is gone", () => {
    // Req 7 is satisfied vacuously — by never reusing — rather than by a
    // cleanup path that has to be correct. This is what a `MAX(uid) + 1` over
    // the sessions table could not promise: deleting the highest row would
    // lower the maximum and re-issue its uid to the next session, handing the
    // new holder whatever the old one left on disk.
    const db = ledger();
    const first = allocateSessionUid(db);
    const second = allocateSessionUid(db);
    // …the session holding `second` is deleted; nothing writes back to the
    // ledger, by design.
    const third = allocateSessionUid(db);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(third).toBeGreaterThan(second);
  });

  it("survives a ledger that has never been written", () => {
    // First boot after the migration: the table exists and is empty.
    const db = ledger();
    expect(allocateSessionUid(db)).toBe(SESSION_UID_MIN);
  });

  it("refuses loudly when the range is exhausted rather than sharing", () => {
    // Req 11. Wrapping would hand a live session's identity to a new one, which
    // is precisely the state this whole feature exists to prevent.
    const db = ledger();
    db.prepare("INSERT INTO session_uid_allocation (id, next_uid) VALUES (1, ?)")
      .run(SESSION_UID_MAX + 1);
    expect(() => allocateSessionUid(db)).toThrow(SessionUidExhaustedError);
  });

  it("leaves the ledger untouched when it refuses", () => {
    const db = ledger();
    db.prepare("INSERT INTO session_uid_allocation (id, next_uid) VALUES (1, ?)")
      .run(SESSION_UID_MAX + 1);
    expect(() => allocateSessionUid(db)).toThrow();
    const row = db.prepare("SELECT next_uid FROM session_uid_allocation WHERE id = 1")
      .get() as { next_uid: number };
    expect(row.next_uid).toBe(SESSION_UID_MAX + 1);
  });
});
