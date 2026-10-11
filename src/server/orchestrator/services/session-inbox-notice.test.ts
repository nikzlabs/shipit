import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { SessionInboxStore } from "../session-inbox-store.js";
import {
  buildInboxNotice,
  containerPredatesShipIt,
  INBOX_TURN_TEXT,
  prepareInboxNotice,
  renderInboxMessage,
} from "./session-inbox-notice.js";

const CHILD = { sessionId: "child", sessionTitle: "Child", relation: "child" as const };

describe("the inbox notice (docs/328-session-message-inbox)", () => {
  let dbManager: DatabaseManager;
  let store: SessionInboxStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    new SessionManager(dbManager).track("parent", "Parent", "/ws/parent");
    store = new SessionInboxStore(dbManager);
  });

  afterEach(() => dbManager.close());

  it("renders with no unfilled token and names the read command", () => {
    for (const unread of [1, 3]) {
      const notice = buildInboxNotice(unread);
      expect(notice).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(notice).toContain("shipit session inbox");
    }
    expect(buildInboxNotice(1)).not.toBe(buildInboxNotice(3));
    expect(INBOX_TURN_TEXT.length).toBeGreaterThan(0);
  });

  it("is owed for an unread message, and not after its receipt", () => {
    expect(prepareInboxNotice(store, "parent")).toBeNull();

    store.add("parent", { origin: CHILD, body: "a report" });
    const notice = prepareInboxNotice(store, "parent");
    expect(notice?.notice).toBe(buildInboxNotice(1));

    // Prepared and not acknowledged: the turn never reached the agent, so it is still owed.
    expect(prepareInboxNotice(store, "parent")).not.toBeNull();

    notice!.delivered();
    expect(prepareInboxNotice(store, "parent")).toBeNull();
  });

  it("acknowledges what it covered, so a message that arrives during the turn is told by the next", () => {
    store.add("parent", { origin: CHILD, body: "before the turn" });
    const notice = prepareInboxNotice(store, "parent")!;

    store.add("parent", { origin: CHILD, body: "during the turn" });
    notice.delivered();

    expect(prepareInboxNotice(store, "parent")?.notice).toBe(buildInboxNotice(2));
  });

  it("carries the messages themselves when asked to, and its receipt marks them read", () => {
    store.add("parent", { origin: CHILD, body: "the regen command is broken" });
    store.add("parent", { body: "Child PR #7 merged" });

    const notice = prepareInboxNotice(store, "parent", { inline: true })!;
    expect(notice.notice).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(notice.notice.indexOf("the regen command is broken")).toBeGreaterThan(-1);
    expect(notice.notice.indexOf("Child PR #7 merged"))
      .toBeGreaterThan(notice.notice.indexOf("the regen command is broken"));
    // An agent's text keeps the frame that names its sender; ShipIt's own text has none.
    expect(notice.notice).toContain(renderInboxMessage(store.unread("parent")[0]!));

    // A message that arrives after the notice was built is not marked read by its receipt.
    store.add("parent", { origin: CHILD, body: "arrived during the turn" });
    notice.delivered();

    expect(store.unread("parent").map((m) => m.body)).toEqual(["arrived during the turn"]);
    expect(prepareInboxNotice(store, "parent", { inline: true })?.notice).toContain("arrived during the turn");
  });

  it("counts a container as older only when both builds are known and differ", () => {
    const build = process.env.SHIPIT_BUILD_ID;
    const withBuild = (workerBuildId: string | undefined) =>
      ({ get: () => ({ status: "running", workerBuildId }) }) as never;
    try {
      process.env.SHIPIT_BUILD_ID = "new-build";
      expect(containerPredatesShipIt(withBuild("old-build"), "parent")).toBe(true);
      expect(containerPredatesShipIt(withBuild("new-build"), "parent")).toBe(false);
      expect(containerPredatesShipIt(withBuild(undefined), "parent")).toBe(false);
      expect(containerPredatesShipIt({ get: () => undefined } as never, "parent")).toBe(false);
      expect(containerPredatesShipIt(undefined, "parent")).toBe(false);
      delete process.env.SHIPIT_BUILD_ID;
      expect(containerPredatesShipIt(withBuild("old-build"), "parent")).toBe(false);
    } finally {
      if (build === undefined) delete process.env.SHIPIT_BUILD_ID;
      else process.env.SHIPIT_BUILD_ID = build;
    }
  });

  it("lets a turn start when the store cannot be read", () => {
    const broken = {
      owed: () => { throw new Error("database is closed"); },
      unread: () => [],
      markNotified: () => {},
      markRead: () => {},
    };
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      expect(prepareInboxNotice(broken, "parent")).toBeNull();
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
  });
});
