import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRunner, type SystemTurnDeps } from "../session-runner.js";
import { adoptInFlightTurn } from "../turn-adoption.js";
import { steerRefused, turnAwaitsAgent, turnTakesMessages } from "../turn-stop-request.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import {
  makeDispatchTurnDeps,
  makeFakeAgent,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

// docs/329-user-steers-every-turn — each way the agent comes to have a turn's prompt.
describe("when a turn takes messages", () => {
  let runner: SessionRunner;
  let agents: FakeAgent[];
  let deps: SystemTurnDeps;

  beforeEach(() => {
    agents = [];
    deps = makeDispatchTurnDeps(agents, []).deps;
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    runner = new SessionRunner({ sessionId: "sess-1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(deps);
  });

  afterEach(() => {
    runner.dispose({ force: true });
    vi.restoreAllMocks();
  });

  it("does when the submission of its prompt returns", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    expect(turnTakesMessages(runner)).toBe(false);

    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");

    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("waits for the worker's answer when the submission is not done on return", async () => {
    let accept: () => void = () => {};
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    deps.agentFactory = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled: () => Promise<void> };
      agent.submissionSettled = () => accepted;
      agents.push(agent);
      return agent as unknown as AgentProcess;
    };

    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt sent");
    expect(turnTakesMessages(runner)).toBe(false);

    accept();
    await waitForTurn(() => turnTakesMessages(runner), "the turn takes messages");
  });

  it("does when the CLI reads the prompt back before the worker's answer", async () => {
    deps.agentFactory = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled: () => Promise<void> };
      agent.submissionSettled = () => new Promise<void>(() => { /* the answer never comes */ });
      agents.push(agent);
      return agent as unknown as AgentProcess;
    };

    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt sent");
    expect(turnTakesMessages(runner)).toBe(false);

    agents[0]!.emit("event", { type: "agent_user_replay", text: "work" });

    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("does for a turn that the CLI starts by itself", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const resident = agents[0]!;
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running, "the turn ended");
    expect(turnTakesMessages(runner)).toBe(false);

    resident.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });

    expect(runner.running).toBe(true);
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("does not for a turn in setup when the CLI wakes by itself on the same process", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const resident = agents[0]!;
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running, "the turn ended");

    let release: () => void = () => {};
    (deps.prepareAgentEnv as unknown) = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return undefined;
    });
    runner.dispatch(testDispatch({ text: "next" }));
    await waitForTurn(() => (deps.prepareAgentEnv as ReturnType<typeof vi.fn>).mock.calls.length === 1, "the next turn's setup");

    // The wake belongs to the CLI's own turn. It must not say the agent has the prompt of "next".
    resident.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    expect(turnTakesMessages(runner)).toBe(false);

    release();
    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the prompt sent");
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("gives a turn that the CLI starts what the user sent before it", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const resident = agents[0]!;
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running && !runner.postTurnWorkInFlight, "the turn ended");
    runner.enqueue({ text: "waits in the queue", execution: "interactive" });

    resident.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });

    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the waiting message delivered");
    expect(String(resident.sendUserMessage.mock.calls[0]?.[0])).toBe("waits in the queue");
  });

  it("gives an adopted turn what waits in the queue", async () => {
    const adopted = makeFakeAgent();
    runner.setAgent(adopted as unknown as AgentProcess);
    runner.enqueue({ text: "waits in the queue", execution: "interactive" });

    await adoptInFlightTurn(runner, deps, adopted as unknown as AgentProcess, {
      agentId: "claude" as AgentId,
      streaming: true,
    });

    await waitForTurn(() => adopted.sendUserMessage.mock.calls.length === 1, "the waiting message delivered");
    expect(String(adopted.sendUserMessage.mock.calls[0]?.[0])).toBe("waits in the queue");
  });

  it("stops shielding a claim whose prompt the agent refused, and asks the runner to check", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const resident = agents[0]! as FakeAgent & { submissionSettled?: () => Promise<void> };
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running && !runner.postTurnWorkInFlight, "the turn ended");

    // The resident is gone on the worker: its answer to the next prompt is a refusal.
    resident.submissionSettled = () => Promise.reject(new Error("No agent running"));
    const verify = vi.spyOn(runner, "verifyRunningState");
    runner.dispatch(testDispatch({ text: "next" }));
    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the prompt sent");
    await waitForTurn(() => verify.mock.calls.length === 1, "the runner asked to check");

    expect(turnTakesMessages(runner)).toBe(false);
    expect(turnAwaitsAgent(runner)).toBe(false);
  });

  it("notes a steer that the harness refuses, and puts the message back in the queue", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const handle = runner.dispatch(testDispatch({ text: "change course", execution: "interactive" }));
    expect(handle.admitted).toBe("steered");

    agents[0]!.emit("event", { type: "agent_steer_rejected", text: "change course" });

    expect(steerRefused(runner)).toBe(true);
    expect(runner.messageQueue.map((m) => m.text)).toEqual(["change course"]);
    // The agent speaks again; that must not send the refused message a second time.
    agents[0]!.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(agents[0]!.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not stop the user's messages when the harness refuses a notice from another source", async () => {
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt submitted");
    const notice = runner.dispatch(
      testDispatch({ text: "you have messages", automatic: true, bestEffortSteer: true }),
      { whenBusy: "steer-or-refuse" },
    );
    expect(notice.admitted).toBe("steered");

    agents[0]!.emit("event", { type: "agent_steer_rejected", text: "you have messages" });

    expect(steerRefused(runner)).toBe(false);
    expect(runner.queueLength).toBe(0);

    // One that goes back to the queue is still not the user's.
    const fromAChild = runner.dispatch(testDispatch({ text: "a child's report", automatic: true }));
    expect(fromAChild.admitted).toBe("steered");
    agents[0]!.emit("event", { type: "agent_steer_rejected", text: "a child's report" });

    expect(runner.messageQueue.map((m) => m.text)).toEqual(["a child's report"]);
    expect(steerRefused(runner)).toBe(false);
  });

  it("does for a turn adopted after an orchestrator restart", async () => {
    const adopted = makeFakeAgent();
    runner.setAgent(adopted as unknown as AgentProcess);

    await adoptInFlightTurn(runner, deps, adopted as unknown as AgentProcess, {
      agentId: "claude" as AgentId,
      streaming: true,
    });

    expect(runner.running).toBe(true);
    expect(turnTakesMessages(runner)).toBe(true);
  });

  it("gives the turn what the user sent during its setup, when the worker has answered", async () => {
    let accept: () => void = () => {};
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    deps.agentFactory = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled: () => Promise<void> };
      agent.submissionSettled = () => accepted;
      agents.push(agent);
      return agent as unknown as AgentProcess;
    };

    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt sent");
    runner.dispatch(testDispatch({ text: "typed during the start", execution: "interactive" }));
    expect(runner.queueLength).toBe(1);
    expect(agents[0]!.sendUserMessage).not.toHaveBeenCalled();

    accept();
    await waitForTurn(() => agents[0]!.sendUserMessage.mock.calls.length === 1, "the waiting message delivered");

    expect(String(agents[0]!.sendUserMessage.mock.calls[0]?.[0])).toBe("typed during the start");
    expect(runner.queueLength).toBe(0);
  });
});
