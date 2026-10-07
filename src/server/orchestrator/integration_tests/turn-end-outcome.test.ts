import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { SessionRunner } from "../session-runner.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { AgentId, LastTurnOutcome } from "../../shared/types.js";
import type { TurnEnd } from "../turn-settlement.js";
import { ProviderRouteUnavailableError } from "../provider-route-preflight.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import { executeAgentTurn } from "../turn-executor.js";

/** docs/324-scheduled-sessions req 31 — the executor persists how each turn ended. */

interface FakeAgent extends EventEmitter {
  run: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}

const QUOTA_ERROR = "You've hit Claude's 5h usage limit. It resets at 2099-01-01T00:00:00.000Z.";

function setup(opts: { billingMode?: "sub" | "key" } = {}) {
  const agents: FakeAgent[] = [];
  const outcomes: LastTurnOutcome[] = [];
  const ends: TurnEnd[] = [];
  const prepareAgentEnv = vi.fn().mockResolvedValue(undefined);
  const deps: SystemTurnDeps = {
    agentFactory: () => {
      const agent = new EventEmitter() as FakeAgent;
      agent.run = vi.fn();
      agent.kill = vi.fn();
      agent.interrupt = vi.fn();
      agents.push(agent);
      return agent as unknown as ReturnType<SystemTurnDeps["agentFactory"]>;
    },
    autoCommit: vi.fn().mockResolvedValue({
      commitHash: null,
      parentHash: null,
      conflictedFiles: [],
      rebaseInProgress: false,
      secretFindings: [],
    }),
    scheduleAutoPush: vi.fn(),
    prepareAgentEnv,
    onTurnEnd: (end) => ends.push(end),
    listenerDeps: {
      sessionManager: {
        setAgentSessionId: vi.fn(),
        setLastTurnErrored: vi.fn(),
        setLastTurnOutcome: (_id: string, outcome: LastTurnOutcome) => outcomes.push(outcome),
        get: vi.fn().mockReturnValue(opts.billingMode ? { agentId: "claude", billingMode: opts.billingMode } : undefined),
        track: vi.fn(),
        touchUnlessResolved: vi.fn(),
        setMuted: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      } as never,
      chatHistoryManager: {
        replaceInProgress: vi.fn(),
        finalizeInProgress: vi.fn(),
        append: vi.fn(),
        updateLastMessage: vi.fn().mockReturnValue(null),
        indexOfMessageId: vi.fn().mockReturnValue(-1),
      } as never,
      usageManager: { record: vi.fn(), getSessionUsage: vi.fn(), getSessionTokenTotals: vi.fn() } as never,
      sseBroadcast: vi.fn(),
      broadcastLog: vi.fn(),
      getSelectedModel: () => undefined,
    },
    buildRunParams: vi.fn().mockResolvedValue({ prompt: "do work", cwd: "/tmp/s1" }),
  };
  const runner = new SessionRunner({ sessionId: "s1", sessionDir: "/tmp/s1", defaultAgentId: "claude" as AgentId });
  runner.setSystemTurnDeps(deps);
  return { runner, deps, agents, outcomes, ends, prepareAgentEnv };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startTurn(runner: SessionRunner, agents: FakeAgent[]): Promise<FakeAgent> {
  runner.dispatch(testDispatch({ text: "do work" }));
  await waitFor(() => agents.length === 1 && agents[0]!.run.mock.calls.length === 1, "agent run");
  return agents[0]!;
}

describe("last_turn_outcome (docs/324-scheduled-sessions req 31)", () => {
  it("records ok for a turn that produced its result", async () => {
    const { runner, agents, outcomes, ends } = setup();
    const agent = await startTurn(runner, agents);
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    agent.emit("done", 0);
    await waitFor(() => !runner.running && ends.length > 0, "turn end");
    expect(outcomes).toEqual(["ok"]);
    expect(ends).toEqual([{ sessionId: "s1", outcome: "ok", submitted: true, first: true }]);
    runner.dispose({ force: true });
  });

  it("records errored, with the error, for a result that reports one", async () => {
    const { runner, agents, ends } = setup();
    const agent = await startTurn(runner, agents);
    agent.emit("event", { type: "agent_result", error: "API Error: 500", sessionId: "agent-sid" });
    agent.emit("done", 0);
    await waitFor(() => !runner.running && ends.length > 0, "turn end");
    expect(ends).toEqual([{ sessionId: "s1", outcome: "errored", submitted: true, first: true, detail: "API Error: 500" }]);
    runner.dispose({ force: true });
  });

  it("records quota-refused once no other credential can take the turn over", async () => {
    const { runner, agents, ends } = setup({ billingMode: "key" });
    const agent = await startTurn(runner, agents);
    agent.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    // The process exits at once: the record must not depend on beating the settlement.
    agent.emit("done", 0);
    await waitFor(() => !runner.running && ends.length > 0, "turn end");
    expect(agents).toHaveLength(1);
    expect(ends).toEqual([{ sessionId: "s1", outcome: "quota-refused", submitted: true, first: true, detail: QUOTA_ERROR }]);
    runner.dispose({ force: true });
  });

  it("records nothing for an attempt a quota retry takes over, and quota-refused when every account refused", async () => {
    const { runner, agents, ends, prepareAgentEnv } = setup();
    prepareAgentEnv.mockImplementation(async (_s: string, _a: AgentId, opts?: { excludeRouteIds?: readonly string[] }) => {
      if ((opts?.excludeRouteIds ?? []).length > 0) {
        throw new ProviderRouteUnavailableError("claude" as AgentId, { reason: "all_exhausted", earliestResetAt: null });
      }
      return { turnRoute: { kind: "account" as const, id: "acct-1" } };
    });
    const agent = await startTurn(runner, agents);
    agent.emit("event", { type: "agent_result", error: QUOTA_ERROR, sessionId: "agent-sid" });
    await waitFor(() => !runner.running, "turn finished");
    expect(agents).toHaveLength(2);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: "quota-refused", submitted: false });
    expect(ends[0]!.detail).toContain("Every connected account refused this turn for quota");
    runner.dispose({ force: true });
  });

  it("records errored and not submitted when the turn fails before the prompt reaches an agent", async () => {
    const { runner, agents, ends, prepareAgentEnv } = setup();
    prepareAgentEnv.mockRejectedValue(new Error("No credential can run this model."));
    runner.dispatch(testDispatch({ text: "do work" }));
    await waitFor(() => ends.length > 0, "turn end");
    expect(agents[0]!.run).not.toHaveBeenCalled();
    expect(ends).toEqual([
      { sessionId: "s1", outcome: "errored", submitted: false, first: true, detail: "No credential can run this model." },
    ]);
    await waitFor(() => !runner.running, "turn finished");
    runner.dispose({ force: true });
  });

  it("records errored for a process that exits without a result, and ok for a turn the user stopped", async () => {
    const crashed = setup();
    const agent = await startTurn(crashed.runner, crashed.agents);
    agent.emit("done", 1);
    // A dispatched turn retries a silent exit once; the retry's exit ends the turn.
    await waitFor(() => crashed.agents.length === 2 && crashed.agents[1]!.run.mock.calls.length === 1, "retry");
    expect(crashed.ends).toEqual([]);
    crashed.agents[1]!.emit("done", 1);
    await waitFor(() => crashed.ends.length > 0, "turn end");
    expect(crashed.ends).toHaveLength(1);
    expect(crashed.ends[0]).toMatchObject({ outcome: "errored", submitted: true, detail: expect.stringContaining("code 1") });
    crashed.runner.dispose({ force: true });

    const stopped = setup();
    const stoppedAgent = await startTurn(stopped.runner, stopped.agents);
    stopped.runner.wasInterrupted = true;
    stoppedAgent.emit("done", 0);
    await waitFor(() => stopped.ends.length > 0, "turn end");
    expect(stopped.ends[0]).toMatchObject({ outcome: "ok" });
    stopped.runner.dispose({ force: true });
  });

  it("records a turn the resident agent started by itself, which keeps its predecessor's result", async () => {
    const { runner, deps, agents, ends } = setup();
    const agent = new EventEmitter() as FakeAgent;
    agent.run = vi.fn();
    agent.kill = vi.fn();
    agent.interrupt = vi.fn();
    agents.push(agent);
    await executeAgentTurn(runner, deps, agent as never, {
      agentId: "claude" as AgentId,
      sessionId: "s1",
      prompt: "p",
      userText: "start a background job",
      emitUserEcho: false,
      persistUserMessage: vi.fn(),
      isNewSession: false,
      fallbackTitle: "t",
      turnStartHeadHash: null,
      drainNext: vi.fn(async () => {}),
      emit: () => {},
      useStreaming: true,
      emitErrorOnNoResult: true,
    });
    await waitFor(() => agent.run.mock.calls.length === 1, "agent run");
    agent.emit("event", { type: "agent_result", status: "success", sessionId: "agent-sid" });
    await waitFor(() => ends.length === 1, "the first turn's end");

    agent.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await flush();
    await flush();
    agent.emit("done", 1);
    await waitFor(() => ends.length === 2, "the woken turn's end");
    expect(ends.map((e) => e.outcome)).toEqual(["ok", "errored"]);
    runner.dispose({ force: true });
  });
});
