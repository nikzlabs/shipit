import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionManager } from "./sessions.js";
import { restoreHeldTurns } from "./held-turns.js";
import { createTestDatabaseManager } from "./integration_tests/test-helpers.js";
import type { DatabaseManager } from "../shared/database.js";
import type { QueuedMessage } from "./session-runner.js";

describe("restoreHeldTurns (docs/321 req 8)", () => {
  let dbManager: DatabaseManager;
  afterEach(() => dbManager.close());

  function runnerOver(store: SessionManager, rebind?: (id: string) => (() => void) | undefined) {
    return {
      sessionId: "s1",
      messageQueue: [] as QueuedMessage[],
      answerHoldStore: store,
      rebindDelivery: rebind,
    };
  }

  it("re-binds a delivery's settlement that a restart took from its saved row", () => {
    dbManager = createTestDatabaseManager();
    new SessionManager(dbManager).track("s1", "Parent");
    new SessionManager(dbManager).holdTurn("s1", {
      text: "Child PR #42 merged",
      execution: "dispatched",
      automatic: true,
      deliveryId: "watch-1:1",
      onTurnComplete: () => {},
    });

    // A new manager is what a restart leaves: the row, without the callback.
    const settle = vi.fn();
    const runner = runnerOver(new SessionManager(dbManager), (id) => (id === "watch-1:1" ? settle : undefined));
    expect(restoreHeldTurns(runner)).toBe(1);

    runner.messageQueue[0]!.onTurnComplete?.({ status: "completed" } as never);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("restores each saved turn once, behind what is already queued", () => {
    dbManager = createTestDatabaseManager();
    const store = new SessionManager(dbManager);
    store.track("s1", "Parent");
    store.holdTurn("s1", { text: "[ci-fix] CI failed", execution: "dispatched", automatic: true });
    const runner = runnerOver(store);
    runner.messageQueue.push({ text: "typed by the user", execution: "interactive" });

    expect(restoreHeldTurns(runner)).toBe(1);
    expect(restoreHeldTurns(runner)).toBe(0);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["typed by the user", "[ci-fix] CI failed"]);
  });
});
