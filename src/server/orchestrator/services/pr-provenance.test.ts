import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { recordWitnessedPrCreate } from "./pr-provenance.js";

/**
 * docs/287-agent-merge-per-repo req 5 — provenance decides whether the agent may
 * merge, so "this session's pull request" has to mean a pull request ShipIt
 * WITNESSED itself opening. Everything else — one found on the branch, one
 * opened in another repository by `--repo` — must leave no record at all, and
 * silently: the consequence is that the agent merges from the PR card, not that
 * something failed.
 */

const REMOTE = "https://github.com/acme/shipit.git";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let sessionId: string;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  sessionId = "s1";
  sessions.track(sessionId, "A session");
  sessions.setRemoteUrl(sessionId, REMOTE);
});

afterEach(() => {
  dbManager.close();
});

function provenance() {
  const s = sessions.get(sessionId);
  return { prNumber: s?.prNumber, prRepoId: s?.prRepoId };
}

describe("recordWitnessedPrCreate", () => {
  it("records a pull request this call opened, in the session's repository", () => {
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
    expect(provenance()).toEqual({ prNumber: 42, prRepoId: "github:acme/shipit" });
  });

  it("records nothing for a pull request that was already open", () => {
    // The one that matters: a pull request found on the branch may have been
    // opened by a person, and adopting it would hand the agent merge rights
    // over their work.
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: true, owner: "acme", repo: "shipit",
    });
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("records nothing when the pull request landed in another repository", () => {
    // `--repo` retargets the create. Number 42 in `acme/other` must never become
    // this session's number 42.
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "other",
    });
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("matches the repository by identity, not by string", () => {
    // The create answers with GitHub's own casing; the session's remote is
    // whatever the user typed. Comparing the raw strings would refuse a
    // legitimate record.
    sessions.setRemoteUrl(sessionId, "git@github.com:Acme/ShipIt.git");
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 7, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
    expect(provenance()).toEqual({ prNumber: 7, prRepoId: "github:acme/shipit" });
  });

  it("records nothing for an owner or repository that cannot be an identity", () => {
    for (const bad of [
      { owner: "", repo: "shipit" },
      { owner: "acme", repo: "" },
      { owner: "acme", repo: "../other" },
      { owner: "acme/evil", repo: "shipit" },
    ]) {
      recordWitnessedPrCreate(sessions, sessionId, { number: 9, alreadyExisted: false, ...bad });
      expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
    }
  });

  it("records nothing for a session that no longer exists", () => {
    expect(() => recordWitnessedPrCreate(sessions, "gone", {
      number: 1, alreadyExisted: false, owner: "acme", repo: "shipit",
    })).not.toThrow();
  });
});

describe("provenance lifecycle", () => {
  beforeEach(() => {
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
  });

  it("is surfaced only as a pair", () => {
    // Half a record cannot authorise anything: a number with no repository
    // names a pull request in whatever repository the session points at now.
    dbManager.db.prepare("UPDATE sessions SET pr_repo_id = NULL WHERE id = ?").run(sessionId);
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("is cleared by the docs/202 re-arm", () => {
    // The recorded number now names a MERGED pull request. Leaving it would let
    // the agent ask ShipIt to merge one that already shipped.
    sessions.markMerged(sessionId);
    sessions.clearMerged(sessionId, { number: 42, url: "u", title: "t", baseBranch: "main" });
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("is cleared when unarchive decides the old pull request no longer applies", () => {
    sessions.clearPriorPrRecord(sessionId);
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("is cleared when origin is repointed at another repository", () => {
    sessions.setRemoteUrl(sessionId, "https://github.com/acme/other.git");
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("is cleared when the session's branch is repointed", () => {
    sessions.setBranch(sessionId, "shipit/feature");
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
    // Same reason as a repointed `origin`: the recorded pull request was opened
    // from the branch this session has just left. The release-branch adoption
    // path repoints a live session's branch without going through any PR reset,
    // so without this the old number stayed and kept authorising a merge of a
    // pull request built from a branch the workspace no longer has out
    // (cross-agent review finding).
    sessions.setBranch(sessionId, "release/0.5.0");
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("survives setting the branch to the value it already has", () => {
    // The many creation-time callers write the branch a session is born with.
    // Clearing on a no-op would discard a valid record for nothing.
    sessions.setBranch(sessionId, "shipit/feature");
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
    sessions.setBranch(sessionId, "shipit/feature");
    expect(provenance()).toEqual({ prNumber: 42, prRepoId: "github:acme/shipit" });
  });

  it("survives rewriting origin to another spelling of the SAME repository", () => {
    // A no-op rewrite must not discard a valid record — the session's pull
    // request is still exactly where it was.
    sessions.setRemoteUrl(sessionId, "git@github.com:Acme/ShipIt.git");
    expect(provenance()).toEqual({ prNumber: 42, prRepoId: "github:acme/shipit" });
  });
});
