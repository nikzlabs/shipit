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
    operation: "set",
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
      baseline: { kind: "revision", revision: "abc" },
    });
    expect(store.get("set-a")).toEqual({
      cardId: "set-a",
      sessionId: SESSION,
      target: { key: "mcp.servers[].enabled", repoUrl: "https://github.com/o/r", item: "notion" },
      operation: "set",
      phase: "pending",
      from: false,
      proposed: true,
      baseline: { kind: "revision", revision: "abc" },
      createdAt: "2026-06-05T00:00:00.000Z",
      agentNotified: false,
    });
  });

  it("returns null for a card it does not hold", () => {
    expect(store.get("set-missing")).toBeNull();
  });

  it("keeps the operation a card proposed, which its value cannot say", () => {
    // `add` and `remove` of one allowlist entry are opposite changes under one
    // key, and both carry the same address.
    create({ operation: "remove", target: { key: "network.egress.hosts[].host", item: "npmjs.org" } });
    expect(store.get("set-a")?.operation).toBe("remove");
  });

  it("moves the phase and stamps a resolution once", () => {
    create();
    expect(store.setPhase(SESSION, "set-a", "applying")).toBe(true);
    // A claim carries no resolution: the card is not finished.
    expect(store.get("set-a")).toMatchObject({ phase: "applying" });
    expect(store.get("set-a")?.resolvedAt).toBeUndefined();

    store.setPhase(SESSION, "set-a", "applied", "2026-06-05T00:05:00.000Z");
    expect(store.get("set-a")).toMatchObject({
      phase: "applied",
      resolvedAt: "2026-06-05T00:05:00.000Z",
    });
  });

  it("refuses a phase change from a session that does not own the card", () => {
    sessions.track("sess-2", "Another session");
    create();

    expect(store.setPhase("sess-2", "set-a", "applied")).toBe(false);
    expect(store.get("set-a")).toMatchObject({ phase: "pending" });
  });

  it("reports a phase change against an unknown card rather than inventing a row", () => {
    expect(store.setPhase(SESSION, "set-missing", "applied")).toBe(false);
    expect(store.claimPhase(SESSION, "set-missing", "pending", "applying")).toBe(false);
    expect(store.get("set-missing")).toBeNull();
  });

  it("rolls back both halves of a transition when one of them throws", () => {
    create();
    expect(() =>
      store.transaction(() => {
        store.setPhase(SESSION, "set-a", "applied", "2026-06-05T00:05:00.000Z");
        throw new Error("the transcript write failed");
      }),
    ).toThrow("the transcript write failed");

    expect(store.get("set-a")).toMatchObject({ phase: "pending" });
    expect(store.get("set-a")?.resolvedAt).toBeUndefined();
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

  describe("listUnnotifiedResolved (docs/299-agent-settings-access req 8)", () => {
    it("holds back the two phases that are still waiting on somebody", () => {
      create({ cardId: "set-pending", phase: "pending" });
      create({ cardId: "set-applying", phase: "applying" });
      create({ cardId: "set-applied", phase: "applied" });
      create({ cardId: "set-dismissed", phase: "dismissed" });
      create({ cardId: "set-failed", phase: "failed" });

      expect(store.listUnnotifiedResolved(SESSION).map((r) => r.cardId))
        .toEqual(["set-applied", "set-dismissed", "set-failed"]);
    });

    it("is oldest first, so several outcomes read in the order they happened", () => {
      create({ cardId: "set-b", phase: "applied", createdAt: "2026-06-05T00:02:00.000Z" });
      create({ cardId: "set-a", phase: "dismissed", createdAt: "2026-06-05T00:01:00.000Z" });

      expect(store.listUnnotifiedResolved(SESSION).map((r) => r.cardId)).toEqual(["set-a", "set-b"]);
    });

    it("answers for one session only", () => {
      sessions.track("sess-2", "Another session");
      create({ cardId: "set-mine", phase: "applied" });
      create({ cardId: "set-theirs", sessionId: "sess-2", phase: "applied" });

      expect(store.listUnnotifiedResolved(SESSION).map((r) => r.cardId)).toEqual(["set-mine"]);
      expect(store.listUnnotifiedResolved("sess-2").map((r) => r.cardId)).toEqual(["set-theirs"]);
    });

    it("stops reporting a card once it is marked, and reading it never marks it", () => {
      create({ cardId: "set-a", phase: "applied" });

      // Two reads in a row: the read is not a consume.
      expect(store.listUnnotifiedResolved(SESSION)).toHaveLength(1);
      expect(store.listUnnotifiedResolved(SESSION)).toHaveLength(1);

      store.markAgentNotified(SESSION, ["set-a"]);
      expect(store.listUnnotifiedResolved(SESSION)).toEqual([]);
      expect(store.get("set-a")?.agentNotified).toBe(true);
    });

    it("refuses a mark from a session that does not own the card", () => {
      sessions.track("sess-2", "Another session");
      create({ cardId: "set-a", phase: "applied" });

      store.markAgentNotified("sess-2", ["set-a"]);
      expect(store.get("set-a")?.agentNotified).toBe(false);
      expect(store.listUnnotifiedResolved(SESSION)).toHaveLength(1);
    });

    it("marks only the caller's own cards out of a mixed batch", () => {
      sessions.track("sess-2", "Another session");
      create({ cardId: "set-mine", phase: "applied" });
      create({ cardId: "set-also-mine", phase: "dismissed" });
      create({ cardId: "set-theirs", sessionId: "sess-2", phase: "applied" });

      store.markAgentNotified(SESSION, ["set-mine", "set-theirs", "set-also-mine"]);
      expect(store.get("set-mine")?.agentNotified).toBe(true);
      expect(store.get("set-also-mine")?.agentNotified).toBe(true);
      expect(store.get("set-theirs")?.agentNotified).toBe(false);
    });
  });

  it("goes when its session does, rather than outliving the transcript it belongs to", () => {
    create();
    dbManager.db.prepare("DELETE FROM sessions WHERE id = ?").run(SESSION);
    expect(store.get("set-a")).toBeNull();
  });
});
