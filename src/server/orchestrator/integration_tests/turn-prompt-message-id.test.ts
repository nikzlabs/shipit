import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRunner, type SystemTurnDeps } from "../session-runner.js";
import { turnTakesMessages } from "../turn-stop-request.js";
import type { AgentId, AgentProcess } from "../../shared/types.js";
import {
  makeDispatchTurnDeps,
  makeFakeAgent,
  testDispatch,
  waitForTurn,
  type FakeAgent,
} from "./dispatch-test-helpers.js";

// docs/007-threads-checkpoints req 5 — the CLI's echo of a turn's prompt names the message a
// rewind can fork the conversation at; the prompt's chat row keeps it once that conversation
// answered.
describe("the CLI's id of a turn's prompt", () => {
  let runner: SessionRunner;
  let agents: FakeAgent[];
  let deps: SystemTurnDeps;
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agents = [];
    deps = makeDispatchTurnDeps(agents, []).deps;
    deps.steerInputs = () => ({ liveSteering: true, steeringCapable: true });
    // As the real builder does: the prompt goes to the CLI as composed.
    deps.buildRunParams = vi.fn(async (_s: string, _a: AgentId, prompt: string) => ({ prompt, cwd: "/tmp/s1" }));
    let nextRowId = 0;
    record = vi.fn();
    Object.assign(deps.listenerDeps.chatHistoryManager, {
      append: () => { nextRowId += 1; return nextRowId; },
      recordUserMessageAgentId: record,
    });
    runner = new SessionRunner({ sessionId: "sess-1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
    runner.setSystemTurnDeps(deps);
  });

  afterEach(() => {
    runner.dispose({ force: true });
    vi.restoreAllMocks();
  });

  const echo = (agent: FakeAgent, text: string, messageId: string) =>
    agent.emit("event", { type: "agent_user_replay", text, messageId });
  const answer = (agent: FakeAgent) =>
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "On it." }] });

  async function firstTurn(index = 0): Promise<FakeAgent> {
    if (index === 0) runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[index]?.run.mock.calls.length === 1, "the prompt submitted");
    const agent = agents[index]!;
    agent.emit("event", { type: "agent_init", agentId: "claude", sessionId: "conv-1" });
    return agent;
  }

  it("stamps a dispatched prompt's row, which has no bubble id, once the conversation answered", async () => {
    const agent = await firstTurn();
    echo(agent, "work", "user-1");
    expect(record).not.toHaveBeenCalled();
    answer(agent);
    expect(record).toHaveBeenCalledWith("sess-1", 1, "user-1");
  });

  it("does not stamp an attempt the CLI never answered: its conversation is not kept", async () => {
    // A stored conversation: an unanswered attempt replaces nothing (docs/007 req 2).
    vi.mocked(deps.listenerDeps.sessionManager.get).mockReturnValue({ id: "sess-1", agentSessionId: "stored" } as never);
    const agent = await firstTurn();
    echo(agent, "work", "user-1");
    agent.emit("event", {
      type: "agent_assistant", synthetic: true, content: [{ type: "text", text: "API Error: 500" }],
    });
    agent.emit("event", { type: "agent_result", status: "error", sessionId: "never-kept" });
    expect(record).not.toHaveBeenCalled();
  });

  it("does not stamp an attempt whose 'successful' result the listener reads as a quota refusal", async () => {
    vi.mocked(deps.listenerDeps.sessionManager.get).mockReturnValue({ id: "sess-1", agentSessionId: "stored" } as never);
    const agent = await firstTurn();
    echo(agent, "work", "user-1");
    agent.emit("event", {
      type: "agent_assistant",
      synthetic: true,
      content: [{ type: "text", text: "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z." }],
    });
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "refused-attempt" });
    expect(record).not.toHaveBeenCalled();
  });

  it("knows the prompt behind the worker's runtime notice", async () => {
    const agent = await firstTurn();
    echo(agent, "Node 22 is not available.\n\nwork", "user-1");
    answer(agent);
    expect(record).toHaveBeenCalledWith("sess-1", 1, "user-1");
  });

  it("keeps the prompt's own id when a later steer's text ends with the prompt", async () => {
    const agent = await firstTurn();
    echo(agent, "work", "user-1");
    echo(agent, "Please reconsider.\n\nwork", "queued-steer");
    answer(agent);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("sess-1", 1, "user-1");
  });

  it("stamps the row again from a retry's echo: the retry's conversation is the one kept", async () => {
    const failed = await firstTurn();
    echo(failed, "work", "failed-attempt");
    failed.emit("done", 1);
    const retry = await firstTurn(1);

    echo(retry, "work", "kept-attempt");
    answer(retry);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("sess-1", 1, "kept-attempt");
  });

  it("stamps a prompt that an idle resident reads", async () => {
    const resident = await firstTurn();
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running && !runner.postTurnWorkInFlight, "the first turn ended");

    runner.dispatch(testDispatch({ text: "next" }));
    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the prompt sent to the resident");
    echo(resident, "next", "user-2");
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    expect(record).toHaveBeenCalledWith("sess-1", 2, "user-2");
  });

  it("leaves a prompt read behind a turn of the CLI's own unstamped: it is stored under another id", async () => {
    const resident = await firstTurn();
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitForTurn(() => !runner.running && !runner.postTurnWorkInFlight, "the first turn ended");

    runner.dispatch(testDispatch({ text: "next" }));
    await waitForTurn(() => resident.sendUserMessage.mock.calls.length === 1, "the prompt sent to the resident");
    resident.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    echo(resident, "next", "queued-command");
    resident.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });

    expect(record).not.toHaveBeenCalledWith("sess-1", 2, "queued-command");
  });

  // docs/007 req 8 — the fork's replay leads the first prompt, and the CLI echoes it whole.
  it("knows a fork's first prompt from its echo, replay in front, as this turn's", async () => {
    deps.buildRunParams = vi.fn(async (_s: string, _a: AgentId, prompt: string) => ({
      prompt: `You are continuing a conversation.\n\n${prompt}`,
      cwd: "/tmp/s1",
    }));
    deps.agentFactory = () => {
      const agent = makeFakeAgent() as FakeAgent & { submissionSettled: () => Promise<void> };
      agent.submissionSettled = () => new Promise<void>(() => { /* the answer never comes */ });
      agents.push(agent);
      return agent as unknown as AgentProcess;
    };
    runner.dispatch(testDispatch({ text: "work" }));
    await waitForTurn(() => agents[0]?.run.mock.calls.length === 1, "the prompt sent");
    expect(turnTakesMessages(runner)).toBe(false);

    echo(agents[0]!, "You are continuing a conversation.\n\nwork", "user-1");

    expect(turnTakesMessages(runner)).toBe(true);
  });
});
