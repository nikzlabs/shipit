import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRunner, type SystemTurnDeps } from "../session-runner.js";
import { adoptInFlightTurn } from "../turn-adoption.js";
import { turnTakesMessages } from "../turn-stop-request.js";
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
