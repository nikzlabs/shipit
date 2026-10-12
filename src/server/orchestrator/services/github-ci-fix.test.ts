import { describe, it, expect, vi } from "vitest";
import { dispatchAutoFix } from "./github-ci-fix.js";
import { TURN_COMPLETED } from "../turn-settlement.js";

describe("dispatchAutoFix (docs/329-user-steers-every-turn)", () => {
  it("dispatches an ordinary automatic turn of its own", () => {
    const handle = { admitted: "started" as const, settled: Promise.resolve(TURN_COMPLETED) };
    const dispatch = vi.fn(() => handle);

    expect(dispatchAutoFix({ dispatch }, "CI failed: lint")).toBe(handle);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [opts, admission] = dispatch.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect(opts).toMatchObject({ text: "CI failed: lint", automatic: true, ciAutoFix: true });
    expect(opts.systemTurn).toBeUndefined();
    // It waits for a running turn and is not steered into it.
    expect(admission).toEqual({ whenBusy: "queue" });
  });
});
