import { describe, it, expect, afterEach, vi } from "vitest";
import { SessionRunner } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";
import type { AgentId } from "../shared/types.js";

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
    // A runner without system-turn dependencies always queues, masking a broken hold.
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

    runner.dispatch(testDispatch({ text: "fix CI", systemTurn: true }));
    runner.dispatch(testDispatch({ text: "resolve", systemTurn: true, postTurn: "none" }));
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(3);

    runner.dispose({ force: true });
  });

  it("starts the held-back turn as soon as the merge has finished", () => {
    const { runner } = runnerWithDeps();
    runner.mergeHold = true;
    runner.dispatch(testDispatch({ text: "user msg mid-merge", execution: "dispatched" }));
    expect(runner.queueLength).toBe(1);

    runner.mergeHold = false;
    expect(runner.running).toBe(false);
    expect(runner.queueLength).toBe(1);

    expect(releaseQueuedTurn(runner)).toBe(true);
    expect(runner.running).toBe(true);
    expect(runner.queueLength).toBe(0);

    runner.dispose({ force: true });
  });
});
