import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import type { SystemTurnDeps } from "./session-runner.js";
import type { TurnOutcome } from "./turn-settlement.js";
import type { AgentId } from "../shared/types.js";
import {
  testDispatch,
  makeFakeAgent,
  makeDispatchTurnDeps,
  waitForTurn,
  flushTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

function makeRunnerWithDeps(): {
  runner: SessionRunner;
  agents: FakeAgent[];
  deps: SystemTurnDeps;
  autoCommit: SystemTurnDeps["autoCommit"];
} {
  const runner = new SessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/does-not-exist-s1",
    defaultAgentId: "claude" as AgentId,
  });
  const agents: FakeAgent[] = [];
  const { deps } = makeDispatchTurnDeps(agents, []);
  deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
  runner.setSystemTurnDeps(deps);
  return { runner, agents, deps, autoCommit: deps.autoCommit };
}

describe("a superseded turn settles (planning#318)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("settles as `interrupted` when a newer turn takes the agent slot", async () => {
    const { runner, agents } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({
      text: "Your PR #1971 merged.",
      systemTurn: true,
      deliveryId: "watch-1:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake turn started");
    expect(runner.systemTurnInProgress).toBe(true);

    const usersAgent = makeFakeAgent();
    runner.setAgent(usersAgent as never);
    await flushTurn();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("interrupted");
    expect(outcomes[0]!.errored).toBe(false);
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("settles WITHOUT running the superseded turn's teardown", async () => {
    const { runner, agents, deps } = makeRunnerWithDeps();
    const postTurnPrFlow = vi.fn(async () => {});
    deps.postTurnPrFlow = postTurnPrFlow;
    runner.enqueue({ text: "queued behind the wake", execution: "dispatched" });

    runner.dispatch(testDispatch({ text: "wake", systemTurn: true, deliveryId: "watch-1:1" }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake turn started");
    expect(runner.running).toBe(true);

    runner.setAgent(makeFakeAgent() as never);
    await flushTurn();

    expect(deps.autoCommit).not.toHaveBeenCalled();
    expect(postTurnPrFlow).not.toHaveBeenCalled();
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);
    expect(runner.running).toBe(true);

    runner.clearQueue();
    runner.dispose({ force: true });
  });

  it("does not fire for the ordinary end-of-turn slot clear", async () => {
    const { runner, agents } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({
      text: "wake",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => outcomes.length === 1, "turn settled");

    expect(outcomes[0]!.status).toBe("completed");

    runner.setAgent(makeFakeAgent() as never);
    await flushTurn();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
  });

  it("settles a user-interrupted turn as `interrupted`, not `no-result`", async () => {
    const { runner, agents } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({
      text: "Your PR #1971 merged.",
      systemTurn: true,
      deliveryId: "watch-1:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake turn started");

    runner.wasInterrupted = true;
    agents[0]!.emit("done", 0);
    await waitForTurn(() => outcomes.length === 1, "turn settled");

    expect(outcomes[0]!.status).toBe("interrupted");
    expect(agents).toHaveLength(1);
  });

  it("settles the turn whose resident process a drained system turn RETIRES", async () => {
    const { runner, agents } = makeRunnerWithDeps();
    const outcomesA: TurnOutcome[] = [];

    runner.dispatch(testDispatch({
      text: "Child PR #2104 merged.",
      systemTurn: true,
      deliveryId: "watch-2104:1",
      onTurnComplete: (o) => outcomesA.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake A started");

    runner.dispatch(testDispatch({
      text: "Child PR #2105 merged.",
      systemTurn: true,
      deliveryId: "watch-2105:1",
    }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "wake B started");

    expect(agents[0]!.kill).toHaveBeenCalled();
    expect(outcomesA).toHaveLength(1);
    expect(outcomesA[0]!.status).toBe("completed");
    agents[0]!.emit("done", 0);
    await flushTurn();
    expect(outcomesA).toHaveLength(1);
    expect(outcomesA[0]!.status).toBe("completed");

    runner.clearQueue();
    runner.dispose({ force: true });
  });

  it("settles the retired turn at the ACCOUNT-FAILOVER retirement site too", async () => {
    const { runner, agents, deps } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];
    let failover = false;
    deps.needsAccountFailover = () => failover;

    runner.dispatch(testDispatch({
      text: "Child PR #2104 merged.",
      systemTurn: true,
      deliveryId: "watch-2104:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake started");

    runner.enqueue({ text: "next", execution: "dispatched" });
    failover = true;
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "user turn started");

    expect(agents[0]!.kill).toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");

    runner.clearQueue();
    runner.dispose({ force: true });
  });

  it("settles the retired turn when a SPAWN-IDENTITY change releases it", async () => {
    const { runner, agents, deps } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];
    deps.listenerDeps.sessionManager.get = vi.fn().mockReturnValue({ model: "opus" }) as never;

    runner.dispatch(testDispatch({
      text: "Child PR #2104 merged.",
      systemTurn: true,
      deliveryId: "watch-2104:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake started");

    // Only a user turn checks the changed spawn identity.
    runner.appliedSpawnIdentity = "claude::fable::default";
    runner.enqueue({ text: "next", execution: "dispatched" });
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "user turn started");

    expect(agents[0]!.kill).toHaveBeenCalled();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");

    runner.clearQueue();
    runner.dispose({ force: true });
  });

  it("still settles as `no-result` when the turn genuinely never ran", async () => {
    const { runner, agents } = makeRunnerWithDeps();
    const outcomes: TurnOutcome[] = [];

    runner.dispatch(testDispatch({
      text: "wake",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "turn started");

    agents[0]!.emit("done", 1);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry started");
    agents[1]!.emit("done", 1);
    await waitForTurn(() => outcomes.length === 1, "turn settled");

    expect(outcomes[0]!.status).toBe("errored");
  });
});
