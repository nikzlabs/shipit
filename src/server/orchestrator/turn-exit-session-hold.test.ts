import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import { takeSessionHold } from "./session-hold.js";
import type { AgentId } from "../shared/types.js";
import type { TurnOutcome } from "./turn-settlement.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  flushTurn,
  waitForTurn,
  type FakeAgent,
} from "./integration_tests/dispatch-test-helpers.js";

function makeRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

async function selfWake(agent: FakeAgent): Promise<void> {
  agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
  await flushTurn();
}

// docs/304 and docs/329-user-steers-every-turn — a self-wake between a one-shot turn's result
// and its exit, and a session hold that a flow takes meanwhile.
describe("a one-shot turn whose process starts a turn of its own before it exits", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup(): {
    agents: FakeAgent[];
    deps: ReturnType<typeof makeDispatchTurnDeps>["deps"];
    settlements: TurnOutcome[];
    onTurnComplete: (outcome: TurnOutcome) => void;
  } {
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    const settlements: TurnOutcome[] = [];
    return {
      agents,
      deps,
      settlements,
      onTurnComplete: (outcome: TurnOutcome) => { settlements.push(outcome); },
    };
  }

  it("leaves the session free, so a later wake starts a turn instead of queueing", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "a child PR merged", automatic: true, onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the turn spawned its agent");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    expect(runner.running).toBe(false);

    // A backgrounded job finishes after the result: the CLI reports a turn ShipIt did not start.
    await selfWake(agents[0]!);
    expect(runner.running).toBe(true);

    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the turn settled");

    runner.dispatch(testDispatch({ text: "your background consult finished", automatic: true }));
    await waitForTurn(() => agents.length === 2, "the later wake started its own turn");
    expect(runner.queueLength).toBe(0);
  });

  it("lets a queue release drain a message sent after the adopted turn, and reaches idle", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    let idleSignals = 0;
    runner.on("idle", () => { idleSignals += 1; });

    runner.dispatch(testDispatch({ text: "a child PR merged", automatic: true, onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the turn spawned its agent");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the turn settled");

    runner.enqueue({ text: "and now do the other thing", execution: "dispatched" });
    expect(releaseQueuedTurn(runner)).toBe(true);
    await waitForTurn(() => agents.length === 2, "the queued turn drained");

    const idleBeforeTheDrainedTurn = idleSignals;
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitForTurn(
      () => idleSignals > idleBeforeTheDrainedTurn,
      "the drained turn reached idle",
    );
    expect(runner.queueLength).toBe(0);
  });

  it("starts a wake that queued between the result and the exit", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "a child PR merged", automatic: true, onTurnComplete }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    // The turn's work is not committed before its exit, so this queues.
    runner.dispatch(testDispatch({ text: "your background consult finished", automatic: true }));
    await flushTurn();
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the turn settled");
    await waitForTurn(() => agents[1]?.run.mock.calls.length === 1, "the queued wake started");
    expect(runner.queueLength).toBe(0);
  });

  it("neither releases nor drains under a hold that a flow took while the turn was exiting", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({
      text: "compact the context",
      automatic: true,
      silent: true,
      onTurnComplete,
    }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    const hold = takeSessionHold(runner);
    runner.enqueue({ text: "and now do the other thing", execution: "dispatched" });

    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the turn settled");

    // Its exit must not hand a rebased workspace to the queued turn.
    expect(runner.sessionHold).toBe(hold);
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);
  });

  it("leaves a hold taken by a flow between turns alone", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "fix the import", onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the turn spawned its agent");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    // The rebase flow takes the workspace between turns (services/rebase-driver.ts).
    const hold = takeSessionHold(runner);
    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the turn settled");

    expect(runner.sessionHold).toBe(hold);
  });
});
