import { describe, it, expect, vi } from "vitest";
import {
  prepareDispatch,
  queuedMessageToDispatchOptions,
  withSettlement,
  type AgentDispatchInit,
  type PreparedDispatch,
} from "./prepared-dispatch.js";
import { SessionRunner, toQueuedMessage } from "./session-runner.js";
import type { AgentDispatchOptions, QueuedMessage } from "./session-runner.js";
import { createTurnSettlement, TURN_COMPLETED } from "./turn-settlement.js";
import type { AgentId } from "../shared/types.js";

const FULL_INIT: AgentDispatchInit = {
  text: "everything",
  agentInterface: { source: "agent_interface_sdk", surface: "preview" },
  messageOrigin: { sessionId: "parent", sessionTitle: "Parent", relation: "parent" },
  execution: "dispatched",
  activity: "Working…",
  images: [{ data: "abc", mediaType: "image/png" }],
  files: [{ path: "src/a.ts" }],
  uploads: [{ path: "/uploads/a.png", type: "upload" }],
  permissionMode: "plan",
  postTurn: "none",
  systemTurn: true,
  onTurnComplete: () => {},
  deliveryId: "watch-1:1",
  dictated: true,
  resetMergedBranch: false,
  compactContext: false,
  silent: undefined,
};

function newRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("PreparedDispatch brand (docs/240 Fix A)", () => {
  it("planning#261: a hand-built AgentDispatchOptions cannot be dispatched (type-level)", () => {
    const runner = newRunner();

    const handRolled: AgentDispatchOptions = { text: "child PR merged", activity: "Resuming…" };
    // @ts-expect-error dispatch requires a PreparedDispatch.
    runner.dispatch(handRolled);

    // @ts-expect-error inline literals lack the dispatch brand.
    runner.dispatch({ text: "inline literal" });

    // @ts-expect-error the executor also requires the dispatch brand.
    void runner.runDispatchedTurn({ text: "inline literal" });

    runner.dispose({ force: true });
    expect(true).toBe(true);
  });

  it("prepareDispatch requires a COMPLETE init — a partial re-opens the hole one level up (type-level)", () => {
    // @ts-expect-error incomplete dispatch initialization.
    prepareDispatch({ text: "only text" });

    // @ts-expect-error attachments do not complete dispatch initialization.
    prepareDispatch({ text: "x", activity: "y", images: undefined });

    expect(prepareDispatch(FULL_INIT).text).toBe("everything");
  });

  it("drops undefined fields rather than materializing them as present-but-undefined", () => {
    const opts = prepareDispatch({ ...FULL_INIT, systemTurn: undefined, activity: undefined });
    expect("systemTurn" in opts).toBe(false);
    expect("activity" in opts).toBe(false);
    expect("text" in opts).toBe(true);
  });

  it("the converter carries EVERY AgentDispatchOptions field out of a queued entry", () => {
    const queued: QueuedMessage = toQueuedMessage(prepareDispatch(FULL_INIT));
    const restored = queuedMessageToDispatchOptions(queued);
    for (const key of Object.keys(prepareDispatch(FULL_INIT)) as (keyof AgentDispatchOptions)[]) {
      expect(restored[key], `field "${key}" was dropped by the converter`).toEqual(
        prepareDispatch(FULL_INIT)[key],
      );
    }
  });

  it("the converter's output is itself dispatchable (the drain has a legal path)", () => {
    const runner = newRunner();
    const prepared: PreparedDispatch = queuedMessageToDispatchOptions({
      text: "drained",
      execution: "dispatched",
      systemTurn: true,
    });
    runner.dispatch(prepared);
    expect(runner.queueLength).toBe(1);
    expect(runner.messageQueue[0]!.systemTurn).toBe(true);
    runner.dispose({ force: true });
  });

  it("withSettlement chains the caller's callback and never skips the settle, even if it throws", async () => {
    const settlement = createTurnSettlement();
    const original = vi.fn(() => { throw new Error("consumer blew up"); });
    const chained = withSettlement(
      prepareDispatch({ ...FULL_INIT, onTurnComplete: original }),
      settlement,
    );

    expect(() => chained.onTurnComplete!(TURN_COMPLETED)).toThrow("consumer blew up");
    expect(original).toHaveBeenCalledWith(TURN_COMPLETED);
    await expect(settlement.settled).resolves.toEqual(TURN_COMPLETED);
  });
});
