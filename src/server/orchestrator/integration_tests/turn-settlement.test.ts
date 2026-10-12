import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionRunner } from "../session-runner.js";
import { createAutoPushScheduler } from "../services/auto-push-scheduler.js";
import { adoptInFlightTurn } from "../turn-adoption.js";
import { releaseQueuedTurn } from "../queue-drain.js";
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

  it("planning#262: a no-result retry that SUCCEEDS settles exactly once, with success", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    const handle = runner.dispatch(testDispatch({
      text: "do work",
      onTurnComplete: (o) => outcomes.push(o),
    }));
    void (async () => {
      outcomes.push({ ...(await handle.settled), detail: "via-handle" });
    })();

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);

    await waitForTurn(() => outcomes.length >= 2, "settlement");
    await flushTurn();

    const callbackOutcomes = outcomes.filter((o) => o.detail !== "via-handle");
    expect(callbackOutcomes).toHaveLength(1);
    expect(callbackOutcomes[0]!.status).toBe("completed");
    expect(callbackOutcomes[0]!.errored).toBe(false);
    expect(outcomes.filter((o) => o.detail === "via-handle")).toHaveLength(1);
    expect(outcomes.find((o) => o.detail === "via-handle")!.status).toBe("completed");

    runner.dispose({ force: true });
  });

  it("planning#262: a turn whose no-result retries are EXHAUSTED settles exactly once, with failure", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({ text: "do work", onTurnComplete: (o) => outcomes.push(o) }));

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first agent run");
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2 && agents[1]!.run.mock.calls.length === 1, "retry agent run");
    agents[1]!.emit("done", 0);

    await waitForTurn(() => outcomes.length > 0, "settlement");
    await flushTurn();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.errored).toBe(true);
    expect(outcomes[0]!.status).toBe("errored");
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
    runner.running = true;

    const handle = runner.dispatch(testDispatch({ text: "queued behind a turn", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    runner.clearQueue();

    const settled = await handle.settled;
    expect(settled.status).toBe("dropped");
    expect(settled.errored).toBe(true);

    runner.running = false;
    runner.dispose({ force: true });
  });

  it("planning#261: a callback-bearing system turn queued behind an ADOPTED turn runs as a system turn and settles", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    const adopted = makeFakeAgent();
    runner.setAgent(adopted as unknown as AgentProcess);
    await adoptInFlightTurn(runner, deps, adopted as unknown as AgentProcess, {
      agentId: "claude" as AgentId,
      streaming: false,
    });
    expect(runner.running).toBe(true);
    expect(agents).toHaveLength(0);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      activity: "Resuming after child PR merged…",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    expect(runner.queueLength).toBe(1);

    adopted.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    adopted.emit("done", 0);

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "wake-turn spawned");
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

  it("planning#562: a system turn queued behind an ADOPTED turn is held while the resident has background work", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const adopted = makeFakeAgent();
    runner.setAgent(adopted as unknown as AgentProcess);
    await adoptInFlightTurn(runner, deps, adopted as unknown as AgentProcess, {
      agentId: "claude" as AgentId,
      streaming: false,
    });

    // The adopted turn owns a backgrounded consult the wake turn would retire with the CLI.
    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    expect(runner.queueLength).toBe(1);

    // Settle without exiting: the adopted process stays resident, as it does in production.
    adopted.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running, "adopted turn settled");
    await flushTurn();

    expect(agents).toHaveLength(0);
    expect(runner.queueLength).toBe(1);
    expect(adopted.kill).not.toHaveBeenCalled();
    expect(runner.getAgent()).toBe(adopted as unknown as AgentProcess);
    expect(outcomes).toEqual([]);

    // Still whole: the entry runs once the background work is gone. Released by hand here —
    // the automatic release lives on the registry's runner, which this harness does not build.
    runner.clearBackgroundTasks();
    expect(releaseQueuedTurn(runner)).toBe(true);
    await waitForTurn(() => agents.length === 1, "wake turn spawned");
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => outcomes.length > 0, "wake-turn settlement");
    expect(outcomes[0]!.status).toBe("completed");

    runner.dispose({ force: true });
  });

  // `withSettlement` resolves the handle even when the consumer throws, but the exception
  // still leaves `settleTurn` — and the hold-release is the step after it (planning#562).
  it("planning#562: a throwing completion callback does not strand the deferred entry", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    runner.dispatch(testDispatch({
      text: "fix CI",
      systemTurn: true,
      onTurnComplete: () => { throw new Error("the watch's persistence blew up"); },
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "system turn started");

    runner.isStreamingActive = true;
    runner.setBackgroundTasks([{ id: "bg-1", description: "Codex consult" }]);

    const outcomes: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "child PR merged — resume",
      systemTurn: true,
      onTurnComplete: (o) => outcomes.push(o),
    }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running, "the drain deferred the wake turn");
    await flushTurn();
    await flushTurn();
    expect(agents).toHaveLength(1);
    expect(runner.queueLength).toBe(1);

    // Exit clears the background work, then the throwing callback runs on the way out.
    agents[0]!.emit("done", 0);
    await waitForTurn(() => agents.length === 2, "wake turn started anyway");

    agents[1]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[1]!.emit("done", 0);
    await waitForTurn(() => outcomes.length > 0, "wake-turn settlement");
    expect(outcomes[0]!.status).toBe("completed");

    runner.dispose({ force: true });
  });

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

    // Check before yielding: the retry supervisor must see the delivery immediately.
    expect(runner.hasDelivery("watch-a:1")).toBe(true);
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");
    expect(runner.hasDelivery("watch-a:1")).toBe(true);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agents[0]!.emit("done", 0);
    await waitForTurn(() => liveAtSettlement.length > 0, "settlement");
    await flushTurn();

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

    runner.dispatch(testDispatch({ text: "actually, do this instead" }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("error", new Error("agent process error"));
    await waitForTurn(() => outcomes.length > 0, "wake settlement");
    await flushTurn();

    expect(outcomes[0]!.errored).toBe(true);
    expect(runner.hasDelivery("watch-c:1")).toBe(false);

    runner.dispose({ force: true });
  });

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
    expect(outcomes).toHaveLength(0);

    runner.dispose({ force: true });

    const outcome = await handle.settled;
    expect(outcome.status).toBe("dropped");
    expect(outcome.errored).toBe(true);
    await flushTurn();
    expect(outcomes.filter((o) => o.detail !== "via-handle")).toHaveLength(1);
    expect(outcomes.filter((o) => o.detail === "via-handle")).toHaveLength(1);
  });

  it("a completed turn disposed inside its post-turn window is NOT reported as never-run", async () => {
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

    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "fix turn start");
    // Withhold done to leave the non-streaming turn's commit pending.
    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    expect(runner.running).toBe(false);
    expect(outcomes).toHaveLength(0);

    runner.dispose({ force: true });

    const outcome = await handle.settled;
    expect(outcome.status).toBe("interrupted");
    expect(outcome.errored).toBe(false);
    expect(outcomes.map((o) => o.status)).toEqual(["interrupted"]);
  });

  it("a streaming turn settles at its own result, and a drained successor does not change that (docs/329)", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    // Streaming lets the successor reuse the process, so no process exit settles the predecessor.
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner.setSystemTurnDeps(deps);

    const first: TurnOutcome[] = [];
    const second: TurnOutcome[] = [];
    runner.dispatch(testDispatch({
      text: "fix the failing test",
      onTurnComplete: (o) => first.push(o),
    }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "first turn start");

    runner.dispatch(testDispatch({
      text: "and now this",
      onTurnComplete: (o) => second.push(o),
    }));
    expect(runner.queueLength).toBe(1);

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => runner.queueLength === 0, "queued turn started");
    await waitForTurn(() => first.length === 1, "first turn settled");
    expect(first.map((o) => o.status)).toEqual(["completed"]);
    expect(agents).toHaveLength(1);

    runner.dispose({ force: true });
    await flushTurn();

    expect(first.map((o) => o.status)).toEqual(["completed"]);
    // A turn that a drain started is told of the disposal too, and it had no result.
    expect(second.map((o) => o.status)).toEqual(["dropped"]);
  });

  // docs/329-user-steers-every-turn — on a reused process, a result can end a turn the CLI started.
  describe("a prompt that enters a resident process behind a turn the CLI started", () => {
    async function setup(over: { settleInRestartStep?: boolean } = {}) {
      const runner = newRunner();
      const agents: FakeAgent[] = [];
      const { deps } = makeDispatchTurnDeps(agents, []);
      deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
      if (over.settleInRestartStep) deps.runRequestedRestart = async (turn) => { turn.settle(); };
      runner.setSystemTurnDeps(deps);

      runner.dispatch(testDispatch({ text: "the user's earlier message" }));
      await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "resident process started");
      const resident = agents[0]!;
      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await waitForTurn(() => !runner.running, "first turn ended");

      // A background job ends while the next turn prepares: the CLI starts a turn of its own.
      deps.prepareAgentEnv = async () => {
        resident.emit("event", { type: "agent_self_wake", taskId: "t1", status: "completed" });
        return {};
      };
      const outcomes: TurnOutcome[] = [];
      runner.dispatch(testDispatch({ text: "Your PR #7 merged.", onTurnComplete: (o) => outcomes.push(o) }));
      await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "wake submitted");
      expect(agents).toHaveLength(1);
      return { runner, resident, outcomes };
    }

    it("does not settle on that turn's result, and settles `completed` on its own", async () => {
      const { runner, resident, outcomes } = await setup();

      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await flushTurn();
      await flushTurn();
      expect(outcomes).toEqual([]);

      resident.emit("event", { type: "agent_user_replay", text: "Your PR #7 merged." });
      resident.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "Resetting the branch" }] });
      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await waitForTurn(() => outcomes.length === 1, "wake settled");

      expect(outcomes.map((o) => o.status)).toEqual(["completed"]);
      runner.dispose({ force: true });
    });

    it("settles `dropped`, so its sender delivers again, when a restart ends the process first", async () => {
      const { runner, resident, outcomes } = await setup({ settleInRestartStep: true });

      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await waitForTurn(() => outcomes.length === 1, "the restart step settled the turn");

      expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
      runner.dispose({ force: true });
    });

    // `interrupted` tells the merge watch that the agent had the prompt, so it must not be said of an unread one.
    it("settles `dropped` when the runner is disposed after that turn's result", async () => {
      const { runner, resident, outcomes } = await setup();
      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await flushTurn();
      await flushTurn();
      expect(outcomes).toEqual([]);

      runner.dispose({ force: true });
      await flushTurn();

      expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
    });

    it("settles `dropped` when a newer turn retires the process before it read the prompt", async () => {
      const { runner, resident, outcomes } = await setup();

      resident.emit("superseded");

      expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
      runner.dispose({ force: true });
    });

    it("settles `dropped` when the next turn takes the process and its listeners", async () => {
      const { runner, resident, outcomes } = await setup();
      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await waitForTurn(() => !runner.running, "the CLI's turn ended");
      expect(outcomes).toEqual([]);

      runner.dispatch(testDispatch({ text: "the user's next message" }));
      await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 2, "next turn submitted");

      expect(outcomes.map((o) => o.status)).toEqual(["dropped"]);
      runner.dispose({ force: true });
    });

    it("settles `interrupted` when the process ends after it read the prompt", async () => {
      const { runner, resident, outcomes } = await setup();
      resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
      await waitForTurn(() => !runner.running, "the CLI's turn ended");
      resident.emit("event", { type: "agent_user_replay", text: "Your PR #7 merged." });

      resident.emit("done", 1);
      await waitForTurn(() => outcomes.length === 1, "the turn settled");

      expect(outcomes.map((o) => o.status)).toEqual(["interrupted"]);
      runner.dispose({ force: true });
    });
  });

  it("the runner stays busy across the post-turn window, so idle reclaim can't take it", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "CI is red — fix it", systemTurn: true }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "fix turn start");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();

    expect(runner.running).toBe(false);
    expect(runner.postTurnWorkInFlight).toBe(true);
    expect(runner.agentBusy).toBe(true);

    runner.dispose();
    expect(runner.disposed).toBe(false);

    agents[0]!.emit("done", 0);
    await flushTurn();
    expect(runner.postTurnWorkInFlight).toBe(false);
    expect(runner.agentBusy).toBe(false);
  });

  it("a debounced auto-push keeps the runner busy, and dispose refuses to reclaim under it", () => {
    const runner = newRunner();
    expect(runner.agentBusy).toBe(false);

    const scheduler = createAutoPushScheduler({
      debounceMs: 60_000,
      githubAuthManager: { authenticated: true, markTokenInvalid: async () => false },
      getRunner: () => runner,
      broadcastLog: () => {},
      chatHistory: { append: () => {} },
    });
    scheduler.schedule({} as never, "s1");
    expect(scheduler.pending("s1")).toBe(true);
    expect(runner.agentBusy).toBe(true);

    runner.dispose();
    expect(runner.disposed).toBe(false);
    expect(scheduler.pending("s1")).toBe(true);

    scheduler.cancel("s1");
    expect(runner.agentBusy).toBe(false);
    runner.dispose();
    expect(runner.disposed).toBe(true);
  });

  it("a superseded turn gives up its post-turn hold instead of leaking it", async () => {
    const runner = newRunner();
    const agents: FakeAgent[] = [];
    const { deps } = makeDispatchTurnDeps(agents, []);
    runner.setSystemTurnDeps(deps);

    runner.dispatch(testDispatch({ text: "CI is red — fix it", systemTurn: true }));
    await waitForTurn(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "fix turn start");

    agents[0]!.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await flushTurn();
    expect(runner.postTurnWorkInFlight).toBe(true);

    // A superseded spawn's done event is discarded as stale.
    agents[0]!.emit("superseded");
    await flushTurn();
    expect(runner.postTurnWorkInFlight).toBe(false);
    expect(runner.agentBusy).toBe(false);
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
