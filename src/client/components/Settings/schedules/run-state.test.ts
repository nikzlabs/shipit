import { describe, it, expect } from "vitest";
import { runState } from "./run-state.js";

/** docs/324-scheduled-sessions reqs 24, 33 — the state a run's history row shows, and when Stop is offered. */

const AT = "2026-10-07T09:30:00.000Z";

describe("runState", () => {
  it("takes Starting, Skipped and Failed from the run's row", () => {
    expect(runState({ outcome: "starting" }, undefined, null)).toEqual({ kind: "starting", label: "Starting", stoppable: true });
    expect(runState({ outcome: "skipped" }, undefined, null)).toMatchObject({ kind: "skipped", stoppable: false });
    expect(runState({ outcome: "failed" }, undefined, null)).toMatchObject({ kind: "failed", stoppable: false });
  });

  it("offers Stop on a failed start whose session is not finished, which would hold back Delete", () => {
    expect(runState({ outcome: "failed" }, {}, null)).toMatchObject({ kind: "failed", stoppable: true });
    expect(runState({ outcome: "failed" }, { runFinishedAt: AT }, null).stoppable).toBe(false);
  });

  it("takes the rest from the run's session", () => {
    expect(runState({ outcome: "started" }, {}, null)).toMatchObject({ kind: "running", stoppable: true });
    expect(runState({ outcome: "started" }, {}, "Waiting for your answer")).toMatchObject({ kind: "needs-you", stoppable: true });
    expect(runState({ outcome: "started" }, { runFinishedAt: AT }, null)).toMatchObject({ kind: "finished", stoppable: false });
    expect(runState({ outcome: "started" }, { runStoppedAt: AT, runFinishedAt: AT }, null)).toMatchObject({ kind: "stopped", stoppable: false });
    expect(runState({ outcome: "started" }, { runStoppedAt: AT }, null)).toMatchObject({ kind: "stopping", stoppable: false });
  });

  it("says when the session is gone, and offers nothing to stop", () => {
    expect(runState({ outcome: "started", sessionDeleted: true }, undefined, null)).toEqual({
      kind: "deleted",
      label: "Session deleted",
      stoppable: false,
    });
  });

  it("treats a run whose session the lists have not caught up with as running", () => {
    expect(runState({ outcome: "started" }, undefined, null)).toMatchObject({ kind: "running", stoppable: true });
  });
});
