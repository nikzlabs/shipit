import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { ChatHistoryManager } from "./chat-history.js";
import { AgentMergeClaimStore, mergeRecordId } from "./agent-merge-claims.js";

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
    claimOne();
    claims.markSettling(SESSION, "sha-head");
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 9, expectedSha: "sha-c", method: "merge",
    })).toBe(false);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 7, state: "settling" });
  });

  it("accepts a claim once the previous one is released", () => {
    claimOne();
    claims.release(SESSION, "sha-head");
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 8, expectedSha: "sha-b", method: "merge",
    })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ prNumber: 8, expectedSha: "sha-b" });
  });

  it("survives a database close and reopen", () => {
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
    claimOne();
    const written: string[] = [];
    claims.releaseAfterRecording(SESSION, "sha-head", () => { written.push("record"); });
    expect(written).toEqual(["record"]);
    expect(claims.get(SESSION)).toBeNull();
  });

  it("rolls the RECORD back when it throws, not just the release", () => {
    claimOne();
    const chatHistory = new ChatHistoryManager(dbManager);
    expect(() => claims.releaseAfterRecording(SESSION, "sha-head", () => {
      chatHistory.append(SESSION, {
        id: "m1", role: "system", text: "the record", timestamp: new Date().toISOString(),
      } as never);
      throw new Error("something later failed");
    })).toThrow();

    expect(claims.get(SESSION)).not.toBeNull();
    expect(chatHistory.load(SESSION)).toHaveLength(0);
  });

  it("records nothing when the row is already gone", () => {
    claimOne();
    claims.release(SESSION, "sha-head");
    const written: string[] = [];
    expect(claims.releaseAfterRecording(SESSION, "sha-head", () => { written.push("record"); })).toBe(false);
    expect(written).toEqual([]);
  });

  it("will not let a refusal delete a settling row", () => {
    claimOne();
    claims.markSettling(SESSION, "sha-head");
    expect(claims.releaseUnmerged(SESSION, "sha-head")).toBe(false);
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("still lets a refusal drop a `merging` row", () => {
    claimOne();
    expect(claims.releaseUnmerged(SESSION, "sha-head")).toBe(true);
    expect(claims.get(SESSION)).toBeNull();
  });
});

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
    expect(armOne()).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({
      state: "pending", origin: "auto", prNumber: 7, expectedSha: "sha-head", method: "squash",
    });
  });

  it("replaces a request at a newer commit", () => {
    armOne();
    expect(armOne({ expectedSha: "sha-new" })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ expectedSha: "sha-new", state: "pending" });
    expect(claims.listPending()).toHaveLength(1);
  });

  it("refuses a request over an attempt whose outcome is unknown", () => {
    claimOne();
    expect(armOne({ expectedSha: "sha-later" })).toBe(false);
    expect(claims.get(SESSION)).toMatchObject({ state: "merging", expectedSha: "sha-head" });
  });

  it("lets a direct merge supersede a request", () => {
    armOne();
    expect(claims.claim({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", method: "merge",
    })).toBe(true);
    expect(claims.get(SESSION)).toMatchObject({ state: "merging", origin: "direct" });
  });

  it("keeps requests out of reconciliation's work list", () => {
    armOne();
    expect(claims.list()).toEqual([]);
    expect(claims.listPending()).toHaveLength(1);
  });

  it("answers `getAttempt` with nothing while the request is only a request", () => {
    armOne();
    expect(claims.getAttempt(SESSION)).toBeNull();
    claims.beginMerging({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", method: "squash",
    });
    expect(claims.getAttempt(SESSION)).toMatchObject({ state: "merging" });
  });

  it("promotes to `merging` from `pending` only", () => {
    armOne();
    const id = { sessionId: SESSION, repoId: REPO, prNumber: 7, method: "squash" as const };
    expect(claims.beginMerging({ ...id, expectedSha: "other-sha" })).toBe(false);
    expect(claims.beginMerging({ ...id, prNumber: 9, expectedSha: "sha-head" })).toBe(false);
    expect(claims.beginMerging({ ...id, method: "merge", expectedSha: "sha-head" })).toBe(false);
    expect(claims.beginMerging({ ...id, expectedSha: "sha-head" })).toBe(true);
    expect(claims.get(SESSION)?.state).toBe("merging");
    expect(claims.beginMerging({ ...id, expectedSha: "sha-head" })).toBe(false);
  });

  it("will not settle a request, which has not been attempted", () => {
    armOne();
    expect(claims.markSettling(SESSION, "sha-head")).toBe(false);
    expect(claims.get(SESSION)?.state).toBe("pending");
  });

  it("cancels this repository's requests and leaves the others alone", () => {
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
    claimOne();
    expect(claims.cancelPendingForRepo(REPO)).toEqual([]);
    expect(claims.get(SESSION)).not.toBeNull();
  });

  it("writes the cancellation notice in the same transaction as the delete", () => {
    armOne();
    const chatHistory = new ChatHistoryManager(dbManager);
    expect(() => claims.releasePending({
      sessionId: SESSION, repoId: REPO, prNumber: 7, expectedSha: "sha-head", method: "squash",
    }, () => {
      chatHistory.append(SESSION, {
        id: "m1", role: "system", text: "cancelled", timestamp: new Date().toISOString(),
      } as never);
      throw new Error("something later failed");
    })).toThrow();

    expect(claims.get(SESSION)).not.toBeNull();
    expect(chatHistory.load(SESSION)).toHaveLength(0);
  });

  it("writes revocation's notices in the same transaction as its deletes", () => {
    armOne();
    const chatHistory = new ChatHistoryManager(dbManager);
    expect(() => claims.cancelPendingForRepo(REPO, () => {
      chatHistory.append(SESSION, {
        id: "m1", role: "system", text: "revoked", timestamp: new Date().toISOString(),
      } as never);
      throw new Error("something later failed");
    })).toThrow();

    expect(claims.get(SESSION)).not.toBeNull();
    expect(chatHistory.load(SESSION)).toHaveLength(0);
  });

  it("tracks which sessions have a merge REST call in flight", () => {
    expect(claims.isMergeInFlight(SESSION)).toBe(false);
    claims.markMergeInFlight(SESSION);
    expect(claims.isMergeInFlight(SESSION)).toBe(true);
    claims.clearMergeInFlight(SESSION);
    expect(claims.isMergeInFlight(SESSION)).toBe(false);
  });

  it("ends a request without touching an attempt", () => {
    armOne();
    const id = { sessionId: SESSION, repoId: REPO, prNumber: 7, method: "squash" as const };
    expect(claims.releasePending({ ...id, expectedSha: "other-sha" })).toBe(false);
    expect(claims.releasePending({ ...id, prNumber: 9, expectedSha: "sha-head" })).toBe(false);
    expect(claims.releasePending({ ...id, expectedSha: "sha-head" })).toBe(true);
    claimOne();
    expect(claims.releasePending({ ...id, expectedSha: "sha-head", method: "merge" })).toBe(false);
    expect(claims.get(SESSION)).not.toBeNull();
  });
});

describe("mergeRecordId", () => {
  it("is derived only from durable row values", () => {
    const claim = { repoId: REPO, prNumber: 7, expectedSha: "sha-head" };
    expect(mergeRecordId(claim)).toBe("agent-merge:github:acme/shipit#7@sha-head");
    expect(mergeRecordId(claim)).toBe(mergeRecordId({ ...claim }));
    expect(mergeRecordId({ ...claim, prNumber: 8 })).not.toBe(mergeRecordId(claim));
  });
});
