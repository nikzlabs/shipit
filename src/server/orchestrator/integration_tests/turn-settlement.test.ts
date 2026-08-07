/**
 * docs/240 Fix B — a dispatched turn SETTLES exactly once, and the outcome
 * carries the failure case.
 *
 * These drive the real `SessionRunner.dispatch` → `runDispatchedTurn` →
 * `executeAgentTurn` path in-process with a fake agent, so the settlement is
 * exercised through the actual turn lifecycle rather than a mock of it.
 *
 * What each guards:
 *
 *   - **planning#262** — `onTurnComplete` used to be passed only to attempt zero, so
 *     a turn that exited with no result and retried fired it ZERO times: neither
 *     the retry's success nor its failure reached the caller. A notify-on-merge
 *     watch therefore sat at `merge-observed` looking healthy forever. Retries
 *     are now attempts *within* one settlement.
 *   - **The errored case** — docs/239 flagged `wakeSessionWithTurn` discarding
 *     `errored`, which lets a consumer conclude "delivered" for a turn that
 *     crashed. The outcome must say so.
 *   - **planning#261** — a callback-bearing system turn queued behind an ADOPTED turn
 *     (one that outlived an orchestrator restart) must still run as a system
 *     turn and settle. The adoption drain used to rebuild the options by hand
 *     and drop `systemTurn` / `onTurnComplete` / `postTurn` / `execution`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { adoptInFlightTurn } from "../turn-adoption.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import type { TurnOutcome } from "../turn-settlement.js";
import {
  testDispatch,
  makeDispatchTurnDeps,
  makeFakeAgent,
  flushTurn,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

function newRunner(): SessionRunner {
  return new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
}

describe("dispatched-turn settlement (docs/240 Fix B)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("SHI-260: a no-result retry that SUCCEEDS settles exactly once, with success", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    const handle = runner.dispatch(testDispatch({
      text: "do work",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    // Collected in the background — the handle resolves partway through the
    // turn below, so we can't await it here.
    void (async () => {
      outcomes.push({ ...(await handle.settled), detail: "via-handle" });
    })();

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    // Attempt zero exits with no result — the executor retries.
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    // The retry succeeds.
    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);

    await waitForTurn(() => outcomes.length >= 2, "settlement");
    await flushTurn();

    // Before the fix this array was EMPTY: the callback rode only attempt zero,
    // whose `done` returned through the "handled" branch without finishing the
    // turn, and the retry carried no callback at all.
    const callbackOutcomes = outcomes.filter((o) => o.detail !== "via-handle");
    expect(callbackOutcomes).toHaveLength(1);
    expect(callbackOutcomes[0]!.status).toBe("completed");
    expect(callbackOutcomes[0]!.errored).toBe(false);
    // The handle resolves with the same outcome (it is the same settlement).
    expect(outcomes.filter((o) => o.detail === "via-handle")).toHaveLength(1);
    expect(outcomes.find((o) => o.detail === "via-handle")!.status).toBe("completed");

    runner.dispose({ force: true });
  });

  it("SHI-260: a turn whose no-result retries are EXHAUSTED settles exactly once, with failure", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({ text: "do work", onTurnComplete: (o) => outcomes.push(o) }));

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    // The retry also produces nothing — the budget is spent, so the turn
    // surfaces an error instead of retrying again.
    agents[1]!.emit("done", 0);

    await waitForTurn(() => outcomes.length > 0, "settlement");
    await flushTurn();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.errored).toBe(true);
    expect(outcomes[0]!.status).toBe("errored");
    // Bounded — no third attempt.
    expect(agents).toHaveLength(2);

    runner.dispose({ force: true });
  });

  it("an errored turn settles with the ERROR outcome, not a success", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    const handle = runner.dispatch(testDispatch({ text: "do work", onTurnComplete: (o) => outcomes.push(o) }));

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("error", new Error("the CLI fell over"));

    const settled = await handle.settled;
    expect(settled.status).toBe("errored");
    expect(settled.errored).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("errored");

    runner.dispose({ force: true });
  });

  it("a queued turn that is discarded settles as `dropped` rather than stranding its consumer", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);
    // Occupy the runner so the next dispatch enqueues instead of starting.
    runner.running = true;

    const handle = runner.dispatch(testDispatch({ text: "queued behind a turn", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    // The user interrupts, so the WS drain clears the queue. Pre-docs/240 the
    // completion signal riding that entry was silently eaten and the consumer
    // stayed "pending" indefinitely.
    runner.clearQueue();

    const settled = await handle.settled;
    expect(settled.status).toBe("dropped");
    expect(settled.errored).toBe(true);

    runner.running = false;
    runner.dispose({ force: true });
  });

  it("SHI-259: a callback-bearing system turn queued behind an ADOPTED turn runs as a system turn and settles", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    // A turn that outlived the orchestrator restart, still running inside the
    // worker. Adoption wires listeners onto it without spawning anything.
    const adopted = makeFakeAgent();
    runner.setAgent(adopted as unknown as AgentProcess);
    await adoptInFlightTurn(runner, deps, adopted as unknown as AgentProcess, {
      agentId: "claude" as AgentId,
      streaming: false,
    });
    expect(runner.running).toBe(true);
    // Adoption spawns nothing — the process is already live in the container.
    expect(agents).toHaveLength(0);

    // A notify-on-merge wake-turn arrives while the adopted turn is running, so
    // it is enqueued (never preempting) carrying its system-turn semantics.
    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    expect(runner.queueLength).toBe(1);

    // The adopted turn finishes; its post-turn drain starts the queued entry.
    adopted.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    adopted.emit("done", 0);

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake-turn spawned");
    // It ran as a SYSTEM turn: before the fix the adoption drain rebuilt the
    // options by hand and this flag (plus the callback) was dropped, so the
    // wake-turn ran as an ordinary turn and the watch never advanced.
    expect(runner.systemTurnInProgress).toBe(true);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);

    await waitForTurn(() => outcomes.length > 0, "wake-turn settlement");
    await flushTurn();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
    expect(runner.systemTurnInProgress).toBe(false);

    runner.dispose({ force: true });
  });
  // -------------------------------------------------------------------------
  // planning#266 — the delivery a turn carries, and when it stops being live
  // -------------------------------------------------------------------------
  //
  // `runner.hasDelivery(id)` replaces planning#260's in-memory `inFlight` set as the
  // answer to "is this server-side delivery still pending?". These drive the
  // real turn lifecycle to pin when that answer flips, because the consumer
  // (`merge-watch`) treats a stale `true` as "do not retry, ever" and a
  // premature `false` as "fire a duplicate".

  it("publishes the delivery for the whole turn and clears it BEFORE the consumer is told", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const liveAtSettlement: boolean[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      systemTurn: true,
      deliveryId: "watch-a:1",
      onTurnComplete: () => liveAtSettlement.push(runner.hasDelivery("watch-a:1")),
    }));

    // Live in the SAME synchronous tick as `running`. The gap before
    // `executeAgentTurn` runs is otherwise a window the retry supervisor would
    // read as "not in flight" — at exactly the slowest sessions.
    expect(runner.hasDelivery("watch-a:1")).toBe(true);
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");
    expect(runner.hasDelivery("watch-a:1")).toBe(true);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => liveAtSettlement.length > 0, "settlement");
    await flushTurn();

    // Ordering matters: the consumer's first act on a non-`completed` outcome is
    // to decide whether to retry, and a delivery still reading as in-flight
    // would suppress that forever.
    expect(liveAtSettlement).toEqual([false]);
    expect(runner.hasDelivery("watch-a:1")).toBe(false);

    runner.dispose({ force: true });
  });

  it("a delivery QUEUED behind a running turn is live for the whole wait, then through its own turn", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "user turn" }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first turn");

    // The wake-turn is enqueued (never preempting). `merge-observed` is its
    // legitimate state for the whole wait — re-firing here is the duplicate-wake
    // bug docs/196 fought twice, so the queued entry must answer truthfully.
    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      systemTurn: true,
      deliveryId: "watch-b:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    expect(runner.queueLength).toBe(1);
    expect(runner.hasDelivery("watch-b:1")).toBe(true);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "wake-turn drained");
    // Still live — it moved from the queue to the running slot.
    expect(runner.hasDelivery("watch-b:1")).toBe(true);

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitForTurn(() => outcomes.length > 0, "wake settlement");
    await flushTurn();
    expect(runner.hasDelivery("watch-b:1")).toBe(false);

    runner.dispose({ force: true });
  });

  it("a wake-turn that ERRORS with work queued behind it does not leave its dead delivery reading as live", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      systemTurn: true,
      deliveryId: "watch-c:1",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake turn");

    // A user message lands mid-wake, so the errored turn's teardown immediately
    // drains a SUCCESSOR that carries no delivery of its own. This is the shape
    // that has to keep working: the failure has just earned a retry, and a dead
    // delivery left published would suppress it permanently. Two independent
    // things make it hold — the settlement clears before reporting, and a
    // starting turn overwrites `activeDeliveryId` with its own (here:
    // `undefined`) — and the assertion holds whichever of them fires first.
    runner.dispatch(testDispatch({ text: "actually, do this instead" }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("error", new Error("agent process error"));
    await waitForTurn(() => outcomes.length > 0, "wake settlement");
    await flushTurn();

    expect(outcomes[0]!.errored).toBe(true);
    expect(runner.hasDelivery("watch-c:1")).toBe(false);

    runner.dispose({ force: true });
  });

  // A turn that had already STARTED used to have nothing bounding it: only
  // QUEUED entries were settled on teardown (`settleDroppedQueueEntries`), and
  // dispose kills the agent without any terminal agent event, so the executor's
  // settling `finally` never ran. The CI auto-fix loop awaits this settlement,
  // so a runner that went away mid-fix-turn parked `AutoFixManager` in
  // `running` — its only exit is the post-turn write — and leaked the arbiter
  // claim for the lifetime of the orchestrator (PR #1904).
  it("a runner disposed mid-turn settles the IN-FLIGHT dispatched turn as `dropped`", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    const handle = runner.dispatch(testDispatch({
      text: "CI is red — fix it",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    void (async () => { outcomes.push({ ...(await handle.settled), detail: "via-handle" }); })();

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "fix turn start");
    await flushTurn();
    // Genuinely in flight — nothing has settled yet.
    expect(outcomes).toHaveLength(0);

    // The runner goes away under the running turn (container restart, archive,
    // shutdown). No `done`, no `error`, no `agent_result` will ever arrive.
    runner.dispose({ force: true });

    const outcome = await handle.settled;
    expect(outcome.status).toBe("dropped");
    expect(outcome.errored).toBe(true);
    await flushTurn();
    // Exactly once, and through the callback adapter too (the pre-docs/240
    // consumers read that, not the handle).
    expect(outcomes.filter((o) => o.detail !== "via-handle")).toHaveLength(1);
    expect(outcomes.filter((o) => o.detail === "via-handle")).toHaveLength(1);
  });

  it("a turn that completes normally is NOT re-settled when its runner is later disposed", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "CI is red — fix it",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "fix turn start");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => outcomes.length > 0, "settlement");

    runner.dispose({ force: true });
    await flushTurn();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("completed");
  });
});
