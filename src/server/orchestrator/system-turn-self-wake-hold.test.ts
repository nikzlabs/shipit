import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "./session-runner.js";
import { releaseQueuedTurn } from "./queue-drain.js";
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

// docs/304 — a self-wake between a system turn's result and its exit.
describe("a CLI-started turn adopted on a non-streaming system turn", () => {
  let runner: SessionRunner;
  afterEach(() => { runner?.dispose({ force: true }); vi.restoreAllMocks(); });

  function setup(): {
    agents: FakeAgent[];
    deps: ReturnType<typeof makeDispatchTurnDeps>["deps"];
    settlements: TurnOutcome[];
    /** The hold is released inside the terminal sequence that ends in settlement, and
     *  `running` is already false by then, so only this marks the turn as torn down. */
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

  it("releases the system-turn hold, so a later wake starts a turn instead of queueing", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "a child PR merged", systemTurn: true, onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the system turn spawned its agent");
    expect(runner.systemTurnInProgress).toBe(true);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    expect(runner.running).toBe(false);

    // A backgrounded job finishes after the result: the CLI reports a turn ShipIt did not start.
    await selfWake(agents[0]!);
    expect(runner.running).toBe(true);

    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the system turn settled");

    expect(runner.systemTurnInProgress).toBe(false);

    // The delivery the incident lost: a wake dispatched minutes later must start a turn.
    runner.dispatch(testDispatch({ text: "your background consult finished", systemTurn: true }));
    await waitForTurn(() => agents.length === 2, "the later wake started its own turn");
    expect(runner.queueLength).toBe(0);
  });

  it("lets a queue release drain a message sent after the adopted turn, and reaches idle", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);
    let idleSignals = 0;
    runner.on("idle", () => { idleSignals += 1; });

    runner.dispatch(testDispatch({ text: "a child PR merged", systemTurn: true, onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the system turn spawned its agent");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the system turn settled");

    // The incident's second half: every message typed afterwards also queued for ever.
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

  it("starts a wake that queued behind the hold between the result and the exit", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "a child PR merged", systemTurn: true, onTurnComplete }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the system turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    // The hold outlives the result, so this queues — and the turn's one drain is spent.
    runner.dispatch(testDispatch({ text: "your background consult finished", systemTurn: true }));
    await flushTurn();
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the system turn settled");
    await waitForTurn(() => agents[1]?.run.mock.calls.length === 1, "the queued wake started");
    expect(runner.queueLength).toBe(0);
  });

  it("neither releases nor drains under a hold taken while it was exiting", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({
      text: "compact the context",
      systemTurn: true,
      silent: true,
      onTurnComplete,
    }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the system turn started");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    runner.systemTurnInProgress = true;
    runner.enqueue({ text: "and now do the other thing", execution: "dispatched" });

    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the system turn settled");

    // Its exit must not hand a rebased workspace to the queued turn.
    expect(runner.systemTurnInProgress).toBe(true);
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);
  });

  it("leaves a hold that changed hands mid-turn alone", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({
      text: "compact the context",
      systemTurn: true,
      silent: true,
      onTurnComplete,
    }));
    await waitForTurn(() => agents.length === 1, "the system turn spawned its agent");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    // A silent turn releases the hold at its own drain, and another owner takes it before
    // this one exits — `services/rebase-driver.ts` acquires it exactly like this.
    expect(runner.systemTurnInProgress).toBe(false);
    runner.systemTurnInProgress = true;

    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the system turn settled");

    expect(runner.systemTurnInProgress).toBe(true);
  });

  it("leaves a hold taken by a driver between turns alone", async () => {
    const { agents, deps, settlements, onTurnComplete } = setup();
    runner = makeRunner();
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "fix the import", onTurnComplete }));
    await waitForTurn(() => agents.length === 1, "the interactive turn spawned its agent");
    expect(runner.systemTurnInProgress).toBe(false);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    // The rebase driver takes the workspace between turns (services/rebase-driver.ts).
    runner.systemTurnInProgress = true;
    await selfWake(agents[0]!);
    agents[0]!.emit("done", 0);
    await waitForTurn(() => settlements.length === 1, "the interactive turn settled");

    expect(runner.systemTurnInProgress).toBe(true);
  });
});
