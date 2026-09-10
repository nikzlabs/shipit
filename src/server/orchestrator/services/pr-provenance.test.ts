import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { recordWitnessedPrCreate } from "./pr-provenance.js";

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
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: true, owner: "acme", repo: "shipit",
    });
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("records nothing when the pull request landed in another repository", () => {
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "other",
    });
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("matches the repository by identity, not by string", () => {
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
    dbManager.db.prepare("UPDATE sessions SET pr_repo_id = NULL WHERE id = ?").run(sessionId);
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("is cleared by the docs/202 re-arm", () => {
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
    sessions.setBranch(sessionId, "release/0.5.0");
    expect(provenance()).toEqual({ prNumber: undefined, prRepoId: undefined });
  });

  it("survives setting the branch to the value it already has", () => {
    sessions.setBranch(sessionId, "shipit/feature");
    recordWitnessedPrCreate(sessions, sessionId, {
      number: 42, alreadyExisted: false, owner: "acme", repo: "shipit",
    });
    sessions.setBranch(sessionId, "shipit/feature");
    expect(provenance()).toEqual({ prNumber: 42, prRepoId: "github:acme/shipit" });
  });

  it("survives rewriting origin to another spelling of the SAME repository", () => {
    sessions.setRemoteUrl(sessionId, "git@github.com:Acme/ShipIt.git");
    expect(provenance()).toEqual({ prNumber: 42, prRepoId: "github:acme/shipit" });
  });
});
