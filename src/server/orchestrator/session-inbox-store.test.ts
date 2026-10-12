import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { SessionInboxStore } from "./session-inbox-store.js";

const CHILD = { sessionId: "child", sessionTitle: "Child", relation: "child" as const };
const APPROVED = { sessionId: "other", sessionTitle: "Other", relation: "proposed" as const };

describe("SessionInboxStore (docs/328-session-message-inbox)", () => {
  let dbManager: DatabaseManager;
  let store: SessionInboxStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    const sessionManager = new SessionManager(dbManager);
    sessionManager.track("parent", "Parent", "/ws/parent");
    sessionManager.track("bystander", "Bystander", "/ws/bystander");
    store = new SessionInboxStore(dbManager);
  });

  afterEach(() => dbManager.close());

  it("returns every unread message in one read, oldest first, and none on the read after (req 4)", () => {
    store.add("parent", { origin: CHILD, body: "first" });
    store.add("parent", { body: "second" });

    const read = store.takeUnread("parent");
    expect(read.map((m) => m.body)).toEqual(["first", "second"]);
    expect(read[0]!.origin).toEqual(CHILD);
    expect(read[1]!.origin).toBeUndefined();
    expect(store.takeUnread("parent")).toEqual([]);
  });

  it("keeps a message after it was read (req 2)", () => {
    store.add("parent", { origin: CHILD, body: "first" });
    store.takeUnread("parent");
    store.add("parent", { origin: CHILD, body: "second" });

    expect(store.all("parent").map((m) => m.body)).toEqual(["first", "second"]);
    expect(store.takeUnread("parent").map((m) => m.body)).toEqual(["second"]);
  });

  it("gives one session's messages to that session only", () => {
    store.add("parent", { origin: CHILD, body: "for the parent" });

    expect(store.takeUnread("bystander")).toEqual([]);
    expect(store.all("bystander")).toEqual([]);
    expect(store.owed("bystander")).toBeUndefined();
  });

  it("owes a notice for an unread message until the agent is told or reads", () => {
    expect(store.owed("parent")).toBeUndefined();

    const first = store.add("parent", { origin: CHILD, body: "first" });
    expect(store.owed("parent")).toEqual({ through: first.id, since: 0, unread: 1, automatic: true });

    store.markNotified("parent", first.id);
    expect(store.owed("parent")).toBeUndefined();

    const second = store.add("parent", { origin: CHILD, body: "second" });
    // The count is every unread message: a read returns the told one too.
    expect(store.owed("parent")).toEqual({ through: second.id, since: first.id, unread: 2, automatic: true });

    store.takeUnread("parent");
    expect(store.owed("parent")).toBeUndefined();
  });

  it("never moves the told mark backwards", () => {
    const first = store.add("parent", { origin: CHILD, body: "first" });
    const second = store.add("parent", { origin: CHILD, body: "second" });

    store.markNotified("parent", second.id);
    store.markNotified("parent", first.id);

    expect(store.owed("parent")).toBeUndefined();
  });

  it("is not automatic while a message the user approved is not told yet (docs/322 req 6)", () => {
    const approved = store.add("parent", { origin: APPROVED, body: "approved by the user" });
    expect(store.owed("parent")?.automatic).toBe(false);

    store.markNotified("parent", approved.id);
    store.add("parent", { origin: CHILD, body: "a later report" });
    expect(store.owed("parent")?.automatic).toBe(true);
  });

  it("lists the sessions that are owed a notice, and no other", () => {
    store.add("parent", { origin: CHILD, body: "unread" });
    const told = store.add("bystander", { origin: CHILD, body: "told" });
    store.markNotified("bystander", told.id);

    expect(store.sessionsOwed()).toEqual(["parent"]);

    store.takeUnread("parent");
    expect(store.sessionsOwed()).toEqual([]);
  });

  it("drops a session's messages with the session", () => {
    store.add("parent", { origin: CHILD, body: "first" });
    store.markNotified("parent", 1);

    dbManager.db.prepare("DELETE FROM sessions WHERE id = ?").run("parent");

    expect(store.all("parent")).toEqual([]);
    expect(dbManager.db.prepare("SELECT COUNT(*) AS n FROM session_inbox_state").get()).toEqual({ n: 0 });
  });
});
