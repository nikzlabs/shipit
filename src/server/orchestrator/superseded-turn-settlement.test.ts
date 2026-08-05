/**
 * SHI-316 — a turn that RAN and was then cut short must settle, and must settle
 * as `interrupted` rather than `no-result`.
 *
 * The production incident: a self-merge wake turn was delivered, the user
 * interrupted it, and the session's next message spawned a fresh agent that took
 * the runner's `_agent` slot. The wake spawn's late `agent_done` then arrived
 * with a stale `runToken` and was dropped by the docs/146 relay guard — correct
 * for the relay (emitting it would run the dead turn's teardown against the live
 * turn's slot) but it left the wake turn's settlement pending FOREVER. Neither
 * `settleAsDropped` net covered it: the runner was alive (so no `disposed`) and
 * the worker truthfully reported an agent running (so no `turn_abandoned`). The
 * merge-watch therefore sat at `merge-observed`, indistinguishable from a
 * delivery that never reached the session, and the retry supervisor re-sent the
 * identical wake prompt 7.5 minutes later.
 *
 * Two properties are pinned here:
 *   1. displacement settles the superseded turn — SETTLEMENT ONLY, no teardown;
 *   2. the outcome distinguishes "ran and was cut short" from "never ran".
 */
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
  // Live steering on, as in production — a user turn streams, a system turn
  // never does.
  deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
  runner.setSystemTurnDeps(deps);
  return { runner, agents, deps, autoCommit: deps.autoCommit };
}

describe("a superseded turn settles (SHI-316)", () => {
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

    // The user's next message spawns a fresh agent, which claims the slot. In
    // production this is `createAgent` on the container runner; here it is the
    // same `setAgent` displacement the local runner performs.
    const usersAgent = makeFakeAgent();
    runner.setAgent(usersAgent as never);
    await flushTurn();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("interrupted");
    // Not flagged as an agent process error: the legacy `errored` projection is
    // what the rebase driver and the CI auto-fix loop still read.
    expect(outcomes[0]!.errored).toBe(false);
    // The stranded system-turn flag is released too — left true it suppresses
    // live steering for the rest of the session.
    expect(runner.systemTurnInProgress).toBe(false);
  });

  it("settles WITHOUT running the superseded turn's teardown", async () => {
    // The displacing turn owns the runner, the agent slot and the working tree.
    // Running the superseded turn's drain / finished-SSE / commit alongside it is
    // exactly the interference the docs/146 stale-spawn guard exists to prevent.
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
    // The queue is untouched: only one agent was ever spawned by this runner's
    // own dispatch path, so nothing drained behind the superseded turn.
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);
    // `running` still belongs to whoever holds the slot now — the superseded turn
    // must not clear it out from under a live turn.
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

    // A LATER turn's spawn now takes the (already-cleared) slot. Nothing to
    // supersede, and the settled outcome must not be rewritten.
    runner.setAgent(makeFakeAgent() as never);
    await flushTurn();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
  });

  it("settles a user-interrupted turn as `interrupted`, not `no-result`", async () => {
    // The same "the human already read it" case reached through the ordinary
    // exit path: the CLI is interrupted, exits without an `agent_result`, and its
    // `done` DOES arrive. Before the fix this was indistinguishable from "the
    // agent never ran", which is the outcome the retry supervisor acts on.
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
    // …and it is NOT retried inside the dispatch path either (a no-result retry
    // would re-run the wake prompt in the same session).
    expect(agents).toHaveLength(1);
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

    // Empty exit → the dispatch path retries once (docs/163), then gives up.
    agents[0]!.emit("done", 1);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry started");
    agents[1]!.emit("done", 1);
    await waitForTurn(() => outcomes.length === 1, "turn settled");

    expect(outcomes[0]!.status).toBe("errored");
  });
});
