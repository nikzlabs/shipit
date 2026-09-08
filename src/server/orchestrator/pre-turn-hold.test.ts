/**
 * docs/295 — the admission hold around a turn's pre-turn phase.
 *
 * Two properties, and the second is the one that matters: the hold must be given
 * back on EVERY exit. A hold left up queues every later message in the session
 * forever, which is a worse failure than the race it exists to prevent.
 */
import { describe, it, expect } from "vitest";
import type { SessionRunnerInterface } from "./session-runner.js";
import { withPreTurnHold } from "./pre-turn-hold.js";

function makeRunner(): SessionRunnerInterface {
  return { preTurnHold: false } as unknown as SessionRunnerInterface;
}

describe("withPreTurnHold", () => {
  it("holds for the whole phase and gives the hold back", async () => {
    const runner = makeRunner();
    const seen: boolean[] = [];
    const result = await withPreTurnHold(runner, async () => {
      seen.push(runner.preTurnHold);
      await Promise.resolve();
      seen.push(runner.preTurnHold);
      return "done";
    });
    expect(result).toBe("done");
    // Both samples: the phase spans several awaits (a merge probe, a compaction
    // spawn, a branch move), and the hold covering only the first was the
    // defect — the destructive half ran with the session readmitting turns.
    expect(seen).toEqual([true, true]);
    expect(runner.preTurnHold).toBe(false);
  });

  it("gives the hold back when the phase throws", async () => {
    const runner = makeRunner();
    await expect(
      withPreTurnHold(runner, () => Promise.reject(new Error("container unreachable"))),
    ).rejects.toThrow("container unreachable");
    expect(runner.preTurnHold).toBe(false);
  });

  it("runs the phase unheld when there is no runner", async () => {
    // A degenerate/test wiring has no admission to gate; refusing the phase
    // would break the turn instead.
    expect(await withPreTurnHold(null, () => Promise.resolve(7))).toBe(7);
  });
});
