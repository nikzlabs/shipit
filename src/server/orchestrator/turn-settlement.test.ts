import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { resultIsTheAgentsOwn, settleWhenRunnerLetsGo, stopLetGoWatch, type TurnOutcome } from "./turn-settlement.js";

describe("resultIsTheAgentsOwn (docs/299-agent-settings-access req 8)", () => {
  it("accepts a plain successful result", () => {
    expect(resultIsTheAgentsOwn({ status: "success" })).toBe(true);
    expect(resultIsTheAgentsOwn({})).toBe(true);
  });

  it("rejects an error status, which is a prompt that did not run", () => {
    expect(resultIsTheAgentsOwn({ status: "error" })).toBe(false);
    expect(resultIsTheAgentsOwn({ status: "error", error: "429 Too Many Requests" })).toBe(false);
  });

  it("rejects an error string on a status that claims success", () => {
    // No shipped adapter emits this pair, which is exactly why the clause needs
    // a test: nothing else would notice a future one that does.
    expect(resultIsTheAgentsOwn({ status: "success", error: "the upstream returned 500" }))
      .toBe(false);
  });
});

// planning#703 — a started turn that goes back to the queue.
describe("stopLetGoWatch", () => {
  function watched(): { runner: EventEmitter & { sessionId: string; activeDeliveryId: undefined }; outcomes: TurnOutcome[]; opts: { text: string; onTurnComplete?: (o: TurnOutcome) => void } } {
    const runner = Object.assign(new EventEmitter(), { sessionId: "s", activeDeliveryId: undefined });
    const outcomes: TurnOutcome[] = [];
    const opts = settleWhenRunnerLetsGo(
      runner as unknown as Parameters<typeof settleWhenRunnerLetsGo>[0],
      { text: "task", onTurnComplete: (o: TurnOutcome) => outcomes.push(o) },
    );
    return { runner, outcomes, opts };
  }

  it("stops an abandoned turn from settling it, and keeps the same callback", () => {
    const { runner, outcomes, opts } = watched();
    expect(stopLetGoWatch(opts.onTurnComplete)).toBe(true);
    runner.emit("turn_abandoned");
    expect(outcomes).toEqual([]);
    opts.onTurnComplete?.({ status: "completed", errored: false });
    expect(outcomes.map((o) => o.status)).toEqual(["completed"]);
  });

  it("is false for a turn the runner already settled, whose sender was told", () => {
    const { runner, outcomes, opts } = watched();
    runner.emit("turn_abandoned");
    expect(stopLetGoWatch(opts.onTurnComplete)).toBe(false);
    expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
  });

  it("is true for a callback with no watch", () => {
    expect(stopLetGoWatch(() => {})).toBe(true);
    expect(stopLetGoWatch(undefined)).toBe(true);
  });
});
