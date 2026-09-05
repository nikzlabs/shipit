import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { AgentMergeClaimStore, mergeRecordId } from "./agent-merge-claims.js";

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

function claimOne(over: { prNumber?: number; expectedSha?: string } = {}) {
  claims.claim({
    sessionId: SESSION,
    repoId: REPO,
    prNumber: over.prNumber ?? 7,
    expectedSha: over.expectedSha ?? "sha-head",
    method: "merge",
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

  it("refuses a second claim while one is outstanding, and keeps the first", () => {
    // Single-flight. Replacing the row was the obvious reading of "one turn,
    // one merge", and it loses a merge that is still in flight: A claims and
    // GitHub merges but A's answer is slow; B replaces A's row, is told "already
    // merged", and releases it; A returns to find no row and reports the merge
    // as settled. The pull request merged and nothing recorded it (cross-agent
    // review finding).
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-a", method: "merge",
    })).toBe(true);
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 8, expectedSha: "sha-b", method: "merge",
    })).toBe(false);
    expect(claims.list()).toHaveLength(1);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 7, expectedSha: "sha-a", state: "merging" });
  });

  it("refuses a claim over a `settling` row too", () => {
    // A `settling` row is proof that a merge HAPPENED and its effects are still
    // being written. Nothing may write over it.
    claimOne();
    claims.markSettling(SESSION, "sha-head");
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 9, expectedSha: "sha-c", method: "merge",
    })).toBe(false);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 7, state: "settling" });
  });

  it("accepts a claim once the previous one is released", () => {
    // The refusal is about an OUTSTANDING attempt, not about the session. A
    // resolved claim must not lock the session out of merging again.
    claimOne();
    claims.release(SESSION, "sha-head");
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 8, expectedSha: "sha-b", method: "merge",
    })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 8, expectedSha: "sha-b" });
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
        sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", method: "merge",
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

  it("rolls the RECORD back when it throws, not just the release", () => {
    // The previous version of this test asserted only that the row survived,
    // which plain `record(); release();` also satisfies. The claim being made is
    // that the two share a transaction, so the record's own database write has
    // to be shown rolling back (cross-agent review finding).
    claimOne();
    const chatHistory = new ChatHistoryManager(dbManager);
    expect(() => claims.releaseAfterRecording(SESSION, "sha-head", () => {
      chatHistory.append(SESSION, {
        id: "m1", role: "system", text: "the record", timestamp: new Date().toISOString(),
      } as never);
      throw new Error("something later failed");
    })).toThrow();

    expect(claims.get(SESSION)).not.toBeNull();
    // …and the write inside the callback is gone with it.
    expect(chatHistory.load(SESSION)).toHaveLength(0);
  });

  it("records nothing when the row is already gone", () => {
    // Two settlements can overlap — a turn's own and the reconciliation that
    // fires at the end of that turn. The row is the permission to record.
    claimOne();
    claims.release(SESSION, "sha-head");
    const written: string[] = [];
    expect(claims.releaseAfterRecording(SESSION, "sha-head", () => { written.push("record"); })).toBe(false);
    expect(written).toEqual([]);
  });

  it("will not let a refusal delete a settling row", () => {
    // The concurrency case: two requests claim the same pull request at the same
    // head, one merges and moves the row to `settling`, and the other gets
    // GitHub's "already merged" refusal. An unconditional delete there erases
    // the winner's evidence and leaves its merge with no record at all.
    claimOne();
    claims.markSettling(SESSION, "sha-head");
    expect(claims.releaseUnmerged(SESSION, "sha-head")).toBe(false);
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("still lets a refusal drop a `merging` row", () => {
    // The ordinary case: an attempt whose outcome nobody learned, refused by
    // GitHub. Nothing merged, so nothing needs recovering.
    claimOne();
    expect(claims.releaseUnmerged(SESSION, "sha-head")).toBe(true);
    expect(claims.get(SESSION)).toBeNull();
  });
});

/**
 * docs/288 — the same row with a life BEFORE the merge call. The distinction the
 * tests are about: `pending` is a REQUEST and may be replaced; `merging` and
 * `settling` are an ATTEMPT and may not.
 */
describe("AgentMergeClaimStore — merge requests", () => {
  function armOne(over: { prNumber?: number; expectedSha?: string } = {}) {
    return claims.arm({
      sessionId: SESSION,
      repoId: REPO,
      prNumber: over.prNumber ?? 7,
      expectedSha: over.expectedSha ?? "sha-head",
      method: "squash",
    });
  }

  it("records a request in `pending`, carrying the merge method", () => {
    // The method is on the row because the merge happens minutes later, in code
    // that has nowhere else to read the flag the agent passed.
    expect(armOne()).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({
      state: "pending", origin: "auto", prNumber: 7, expectedSha: "sha-head", method: "squash",
    });
  });

  it("replaces a request at a newer commit", () => {
    // An agent that pushes again and re-arms is the ORDINARY case, not a
    // collision: the old request names a commit that no longer exists on the
    // branch, so refusing here would strand the session on a dead request.
    armOne();
    expect(armOne({ expectedSha: "sha-new" })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ expectedSha: "sha-new", state: "pending" });
    expect(claims.listPending()).toHaveLength(1);
  });

  it("refuses a request over an attempt whose outcome is unknown", () => {
    // Single-flight, unchanged from docs/287: writing over a `merging` row loses
    // a merge that may already have happened.
    claimOne();
    expect(armOne({ expectedSha: "sha-later" })).toBe(false);
    expect(claims.get(SESSION)).toMatchObject({ state: "merging", expectedSha: "sha-head" });
  });

  it("lets a direct merge supersede a request", () => {
    // `gh pr merge` is the agent saying "now", which makes the request it
    // replaces redundant. Refusing would answer with docs/287's "an earlier
    // merge has not been resolved" for something that never started.
    armOne();
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", method: "merge",
    })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ state: "merging", origin: "direct" });
  });

  it("keeps requests out of reconciliation's work list", () => {
    // `list()` feeds settlement, which asks "did this merge?" and DELETES the row
    // when the answer is no. A request has not been attempted, so that question
    // would destroy every one of them at the first end of turn.
    armOne();
    expect(claims.list()).toEqual([]);
    expect(claims.listPending()).toHaveLength(1);
  });

  it("answers `getAttempt` with nothing while the request is only a request", () => {
    // What reconciliation reads. It resolves ATTEMPTS, and asking "did this
    // merge?" about a request that was never attempted answers no.
    armOne();
    expect(claims.getAttempt(SESSION)).toBeNull();
    claims.beginMerging(SESSION, "sha-head");
    expect(claims.getAttempt(SESSION)).toMatchObject({ state: "merging" });
  });

  it("promotes to `merging` from `pending` only", () => {
    armOne();
    expect(claims.beginMerging(SESSION, "other-sha")).toBe(false);
    expect(claims.beginMerging(SESSION, "sha-head")).toBe(true);
    expect(claims.get(SESSION)?.state).toBe("merging");
    // The filter is what stops two executors, or an executor and a revocation,
    // both acting on one request.
    expect(claims.beginMerging(SESSION, "sha-head")).toBe(false);
  });

  it("will not settle a request, which has not been attempted", () => {
    armOne();
    expect(claims.markSettling(SESSION, "sha-head")).toBe(false);
    expect(claims.get(SESSION)?.state).toBe("pending");
  });

  it("cancels this repository's requests and leaves the others alone", () => {
    // req 4 — revocation is per repository, matched on the same `repoId` the
    // grant is, so one repository's withdrawal cannot cancel another's request.
    sessions.track("s2", "Another session");
    armOne();
    claims.arm({
      sessionId: "s2", repoId: "github:acme/other", prNumber: 3, expectedSha: "sha-2",
      method: "merge",
    });
    const cancelled = claims.cancelPendingForRepo(REPO);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ sessionId: SESSION, prNumber: 7 });
    expect(claims.get(SESSION)).toBeNull();
    expect(claims.get("s2")).not.toBeNull();
  });

  it("leaves an attempt alone when the permission is withdrawn", () => {
    // A row past `pending` is being settled or resolved from its tuple, and can
    // no longer merge anything — so there is nothing left to cancel, and
    // deleting it would destroy the only evidence a merge happened.
    claimOne();
    expect(claims.cancelPendingForRepo(REPO)).toEqual([]);
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("ends a request without touching an attempt", () => {
    armOne();
    expect(claims.releasePending(SESSION, "other-sha")).toBe(false);
    expect(claims.releasePending(SESSION, "sha-head")).toBe(true);
    claimOne();
    expect(claims.releasePending(SESSION, "sha-head")).toBe(false);
    expect(claims.get(SESSION)).not.toBeNull();
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
