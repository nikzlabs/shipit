import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { SettingsProposalStore } from "./settings-proposal-store.js";

let dbManager: DatabaseManager;
let sessions: SessionManager;
let store: SettingsProposalStore;

const SESSION = "sess-1";

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessions = new SessionManager(dbManager);
  store = new SettingsProposalStore(dbManager);
  sessions.track(SESSION, "A session");
});

afterEach(() => {
  dbManager.close();
});

function create(over: Partial<Parameters<SettingsProposalStore["create"]>[0]> = {}) {
  store.create({
    cardId: "set-a",
    sessionId: SESSION,
    target: { key: "advanced.enableSubAgents" },
    phase: "pending",
    from: false,
    proposed: true,
    createdAt: "2026-06-05T00:00:00.000Z",
    ...over,
  });
}

describe("SettingsProposalStore", () => {
  it("round-trips the target, the values and the phase", () => {
    create({
      target: { key: "mcp.servers[].enabled", repoUrl: "https://github.com/o/r", item: "notion" },
    });
    expect(store.get("set-a")).toEqual({
      cardId: "set-a",
      sessionId: SESSION,
      target: { key: "mcp.servers[].enabled", repoUrl: "https://github.com/o/r", item: "notion" },
      phase: "pending",
      from: false,
      proposed: true,
      createdAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("returns null for a card it does not hold", () => {
    expect(store.get("set-missing")).toBeNull();
  });

  it("starts with no baseline, and takes the one the apply layer writes", () => {
    create();
    expect(store.get("set-a")?.baseline).toBeUndefined();

    expect(store.setBaseline("set-a", { enableSubAgents: false, revision: 7 })).toBe(true);
    expect(store.get("set-a")?.baseline).toEqual({ enableSubAgents: false, revision: 7 });
  });

  it("moves the phase and stamps a resolution once", () => {
    create();
    expect(store.setPhase("set-a", "applying")).toBe(true);
    // A claim carries no resolution: the card is not finished.
    expect(store.get("set-a")).toMatchObject({ phase: "applying" });
    expect(store.get("set-a")?.resolvedAt).toBeUndefined();

    store.setPhase("set-a", "applied", "2026-06-05T00:05:00.000Z");
    expect(store.get("set-a")).toMatchObject({
      phase: "applied",
      resolvedAt: "2026-06-05T00:05:00.000Z",
    });
  });

  it("reports a phase change against an unknown card rather than inventing a row", () => {
    expect(store.setPhase("set-missing", "applied")).toBe(false);
    expect(store.setBaseline("set-missing", 1)).toBe(false);
    expect(store.get("set-missing")).toBeNull();
  });

  describe("latestForTarget", () => {
    it("is the last proposal for the target from ANY session", () => {
      sessions.track("sess-2", "Another session");
      create({ cardId: "set-old", createdAt: "2026-06-05T00:00:00.000Z", phase: "dismissed" });
      create({
        cardId: "set-new",
        sessionId: "sess-2",
        createdAt: "2026-06-05T00:10:00.000Z",
        phase: "pending",
      });

      expect(store.latestForTarget({ key: "advanced.enableSubAgents" })).toMatchObject({
        cardId: "set-new",
        sessionId: "sess-2",
      });
    });

    it("separates instances of one key, so a change to one item is not read off another", () => {
      create({ cardId: "set-notion", target: { key: "mcp.servers[].enabled", item: "notion" } });
      create({ cardId: "set-linear", target: { key: "mcp.servers[].enabled", item: "linear" } });

      expect(store.latestForTarget({ key: "mcp.servers[].enabled", item: "linear" })?.cardId)
        .toBe("set-linear");
      // An unaddressed lookup must not match an addressed row.
      expect(store.latestForTarget({ key: "mcp.servers[].enabled" })).toBeNull();
    });

    it("returns null for a target nothing has proposed", () => {
      expect(store.latestForTarget({ key: "git.identity" })).toBeNull();
    });
  });

  it("goes when its session does, rather than outliving the transcript it belongs to", () => {
    create();
    dbManager.db.prepare("DELETE FROM sessions WHERE id = ?").run(SESSION);
    expect(store.get("set-a")).toBeNull();
  });
});
