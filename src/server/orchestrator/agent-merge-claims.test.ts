import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { AgentMergeClaimStore, currentTurnId, mergeRecordId } from "./agent-merge-claims.js";

/**
 * docs/287-agent-merge-per-repo §4 — the durable claim.
 *
 * The row exists because the merge call can reject AFTER GitHub accepted it. Its
 * whole job is to turn "we do not know whether that merged" into a question that
 * can still be answered later, so the tests are about what survives and what
 * cannot be clobbered.
 */

let dbManager: DatabaseManager;
let claims: AgentMergeClaimStore;
let sessions: SessionManager;

const SESSION = "s1";
const REPO = "github:acme/shipit";

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  claims = new AgentMergeClaimStore(dbManager);
  sessions.track(SESSION, "A session");
});

afterEach(() => {
  dbManager.close();
});

function claimOne(over: { prNumber?: number; expectedSha?: string; turnId?: string } = {}) {
  claims.claim({
    sessionId: SESSION,
    repoId: REPO,
    prNumber: over.prNumber ?? 7,
    expectedSha: over.expectedSha ?? "sha-head",
    turnId: over.turnId ?? currentTurnId(1),
  });
}

describe("AgentMergeClaimStore", () => {
  it("records a claim in the `merging` state", () => {
    claimOne();
    expect(claims.get(SESSION)).toMatchObject({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", state: "merging",
    });
  });

  it("moves to `settling` only for the SHA that was claimed", () => {
    claimOne();
    // A late transition from a superseded attempt must not promote the row that
    // replaced it.
    expect(claims.markSettling(SESSION, "some-other-sha")).toBe(false);
    expect(claims.get(SESSION)?.state).toBe("merging");
    expect(claims.markSettling(SESSION, "sha-head")).toBe(true);
    expect(claims.get(SESSION)?.state).toBe("settling");
  });

  it("releases only the SHA that was claimed", () => {
    claimOne();
    expect(claims.release(SESSION, "some-other-sha")).toBe(false);
    expect(claims.get(SESSION)).not.toBeNull();
    expect(claims.release(SESSION, "sha-head")).toBe(true);
    expect(claims.get(SESSION)).toBeNull();
  });

  it("replaces an older claim rather than accumulating one per attempt", () => {
    // A session runs one turn and a turn performs one merge, so an older row is
    // a spent attempt — keeping it would make reconciliation ask about a pull
    // request nobody is merging.
    claimOne({ prNumber: 7, expectedSha: "sha-a" });
    claimOne({ prNumber: 8, expectedSha: "sha-b" });
    expect(claims.list()).toHaveLength(1);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 8, expectedSha: "sha-b", state: "merging" });
  });

  it("survives a database close and reopen", () => {
    // The point of the row. An in-memory claim would be exactly as useful as no
    // claim in the case it exists for: a crash.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-merge-claims-"));
    const file = path.join(dir, "shipit.db");
    try {
      const first = new DatabaseManager(file);
      new SessionManager(first).track(SESSION, "A session");
      new AgentMergeClaimStore(first).claim({
        sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", turnId: "t",
      });
      first.close();

      const second = new DatabaseManager(file);
      try {
        expect(new AgentMergeClaimStore(second).get(SESSION)).toMatchObject({
          prNumber: 7, expectedSha: "sha-head", state: "merging",
        });
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("goes away with its session", () => {
    claimOne();
    dbManager.db.prepare("DELETE FROM sessions WHERE id = ?").run(SESSION);
    expect(claims.get(SESSION)).toBeNull();
  });

  it("records and releases atomically", () => {
    // "Record, then delete" is not crash-idempotent: a transcript notice gets a
    // random id, so a crash between the two produces a second notice when
    // recovery re-settles the surviving row.
    claimOne();
    const written: string[] = [];
    claims.releaseAfterRecording(SESSION, "sha-head", () => { written.push("record"); });
    expect(written).toEqual(["record"]);
    expect(claims.get(SESSION)).toBeNull();
  });

  it("keeps the claim when recording throws", () => {
    claimOne();
    expect(() => claims.releaseAfterRecording(SESSION, "sha-head", () => {
      throw new Error("history unavailable");
    })).toThrow();
    // Neither happened, so the row is still there to try again.
    expect(claims.get(SESSION)).not.toBeNull();
  });
});

describe("turn identity", () => {
  it("does not repeat across processes for the same epoch", () => {
    // `turnEpoch` restarts at 0 whenever a runner is recreated. A bare epoch
    // would let a claim from a previous process read as the currently active
    // turn, and a stale claim would write session state into an unrelated turn.
    expect(currentTurnId(0)).not.toBe("0");
    expect(currentTurnId(0)).not.toBe(currentTurnId(1));
    expect(currentTurnId(3)).toBe(currentTurnId(3));
  });
});

describe("mergeRecordId", () => {
  it("is derived only from durable row values", () => {
    // A settlement resumed after a restart must derive the SAME string the
    // first attempt did, or the record fires once per recovery instead of once.
    const claim = { repoId: REPO, prNumber: 7, expectedSha: "sha-head" };
    expect(mergeRecordId(claim)).toBe("agent-merge:github:acme/shipit#7@sha-head");
    expect(mergeRecordId(claim)).toBe(mergeRecordId({ ...claim }));
    expect(mergeRecordId({ ...claim, prNumber: 8 })).not.toBe(mergeRecordId(claim));
  });
});
