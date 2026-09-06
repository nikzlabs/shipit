import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionRunner } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";
import type { AgentId } from "../shared/types.js";

/**
 * docs/288 req 6 — a merge ShipIt performs and a turn are mutually exclusive.
 *
 * The half tested here is "a turn does not start while such a merge is in
 * progress, and a turn held back for that reason starts as soon as the merge has
 * finished". The other half — the executor refusing to merge a busy session —
 * is in `services/agent-merge-executor.test.ts`.
 *
 * The system-turn deps are wired deliberately: `dispatch` on a runner WITHOUT
 * them falls back to a plain enqueue for every input, so a test built on a bare
 * runner would pass whether the hold is consulted or not.
 */

function runnerWithDeps() {
  const agents: FakeAgent[] = [];
  const runner = new SessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude" as AgentId,
  });
  const { deps } = makeDispatchTurnDeps(agents, []);
  runner.setSystemTurnDeps(deps);
  return { runner, agents };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turn admission under a merge hold", () => {
  it("starts a turn on an idle runner — the control the rest of this file needs", () => {
    // Without this, "it queued" below proves nothing: the fallback enqueue on a
    // runner with no system-turn deps looks identical to the hold working.
    const { runner } = runnerWithDeps();
    runner.dispatch(testDispatch({ text: "ordinary turn" }));
    expect(runner.running).toBe(true);
    expect(runner.queueLength).toBe(0);
    runner.dispose({ force: true });
  });

  it("queues a turn while ShipIt is merging this session's pull request", () => {
    const { runner } = runnerWithDeps();
    runner.mergeHold = true;

    runner.dispatch(testDispatch({ text: "user msg mid-merge" }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);

    // No exception for a system turn either. The rebase driver's own resolution
    // turn is exempt from `systemTurnInProgress` because it is a step inside a
    // git operation that driver owns; nothing here owns the merge, and any turn
    // at all would push behind a merge already in flight.
    runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    runner.dispatch(testDispatch({ text: "resolve", systemTurn: true, postTurn: "none" }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(3);

    runner.dispose({ force: true });
  });

  it("starts the held-back turn as soon as the merge has finished", () => {
    // The last sentence of req 6. Draining is event-driven and a background
    // merge has no owning turn whose completion would drain the queue, so
    // clearing the hold alone would leave the message sitting there until some
    // unrelated event — which is why the executor calls `releaseQueuedTurn`.
    const { runner } = runnerWithDeps();
    runner.mergeHold = true;
    runner.dispatch(testDispatch({ text: "user msg mid-merge", execution: "dispatched" }));
    expect(runner.queueLength).toBe(1);

    // Clearing the hold on its own moves nothing.
    runner.mergeHold = false;
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);

    expect(releaseQueuedTurn(runner)).toBe(true);
    expect(runner.running).toBe(true);
    expect(runner.queueLength).toBe(0);

    runner.dispose({ force: true });
  });
});
