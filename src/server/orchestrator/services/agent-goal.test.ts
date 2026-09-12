import { describe, it, expect, vi } from "vitest";
import {
  describeGoalResult,
  recordAgentGoal,
  recordGoalForThread,
  goalAgentFor,
  reconcileAgentGoal,
  refreshAgentGoalAfterTurn,
  runGoalExclusive,
} from "./agent-goal.js";
import type { AgentProcess } from "../../shared/types.js";

const GOAL = { objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 1200, timeUsedSeconds: 5, updatedAt: 1 };

function fakeSessions(over: Record<string, unknown> = {}) {
  return {
    setAgentGoal: vi.fn().mockReturnValue(true),
    list: () => [],
    get: vi.fn(() => ({ agentSessionId: "thread-1" })),
    agentGoalChecked: vi.fn(() => false),
    ...over,
  };
}

describe("recordAgentGoal", () => {
  it("broadcasts the session list only when the shown goal changed", () => {
    const sessionManager = fakeSessions({ setAgentGoal: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) });
    const sseBroadcast = vi.fn();
    const deps = { sessionManager: sessionManager as never, sseBroadcast };

    recordAgentGoal(deps, "s1", GOAL);
    recordAgentGoal(deps, "s1", { ...GOAL, tokensUsed: 2000 });

    expect(sessionManager.setAgentGoal).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
    expect(sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [] });
  });
});

describe("recordGoalForThread", () => {
  it("drops an answer about a thread the session no longer uses", () => {
    const sessionManager = fakeSessions({ get: vi.fn(() => ({ agentSessionId: "thread-2" })) });
    recordGoalForThread({ sessionManager: sessionManager as never, sseBroadcast: vi.fn() }, "s1", "thread-1", GOAL);
    expect(sessionManager.setAgentGoal).not.toHaveBeenCalled();
  });
});

describe("runGoalExclusive", () => {
  it("runs one operation per session at a time, in order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = runGoalExclusive("s-order", async () => {
      order.push("first:start");
      await new Promise<void>((r) => { release = r; });
      order.push("first:end");
    });
    const second = runGoalExclusive("s-order", async () => { order.push("second"); });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not let a failure block the next operation", async () => {
    await expect(runGoalExclusive("s-fail", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(runGoalExclusive("s-fail", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("reconcileAgentGoal (docs/154 req 6)", () => {
  const goalAgent = () => ({ goalCommand: vi.fn(async () => ({ goal: GOAL })) }) as unknown as AgentProcess;

  it("reads a never-read goal once, for the session's thread", async () => {
    const sessionManager = fakeSessions();
    const agent = goalAgent();
    await reconcileAgentGoal({ sessionManager: sessionManager as never, sseBroadcast: vi.fn() }, "s1", "codex", () => agent);
    expect(agent.goalCommand).toHaveBeenCalledWith("thread-1", { action: "get" });
    expect(sessionManager.setAgentGoal).toHaveBeenCalledWith("s1", GOAL);
  });

  it("does nothing for a goal already read, a session with no thread, or an agent without goals", async () => {
    const createAgent = vi.fn(goalAgent);
    const deps = (over: Record<string, unknown>) => ({ sessionManager: fakeSessions(over) as never, sseBroadcast: vi.fn() });
    await reconcileAgentGoal(deps({ agentGoalChecked: vi.fn(() => true) }), "s1", "codex", createAgent);
    await reconcileAgentGoal(deps({ get: vi.fn(() => ({})) }), "s1", "codex", createAgent);
    await reconcileAgentGoal(deps({}), "s1", "opencode", createAgent);
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("refreshAgentGoalAfterTurn (docs/297 req 2)", () => {
  const goalAgent = (goal: typeof GOAL | null = GOAL, agentId = "claude") =>
    ({ agentId, goalCommand: vi.fn(async () => ({ goal })) }) as unknown as AgentProcess;

  it("re-reads while a goal is on show, so a goal the CLI cleared silently disappears", async () => {
    const sessionManager = fakeSessions({ get: vi.fn(() => ({ agentSessionId: "thread-1", agentGoal: GOAL })) });
    const agent = goalAgent(null);
    await refreshAgentGoalAfterTurn(
      { sessionManager: sessionManager as never, sseBroadcast: vi.fn() }, "s1", "claude", () => agent,
    );
    expect(agent.goalCommand).toHaveBeenCalledWith("thread-1", { action: "get" });
    expect(sessionManager.setAgentGoal).toHaveBeenCalledWith("s1", null);
  });

  it("costs nothing for a session showing no goal, or an agent without goals", async () => {
    const agent = goalAgent();
    const deps = (over: Record<string, unknown>) => ({ sessionManager: fakeSessions(over) as never, sseBroadcast: vi.fn() });
    // No goal on show; no thread; a harness with no goal store.
    await refreshAgentGoalAfterTurn(deps({}), "s1", "claude", () => agent);
    await refreshAgentGoalAfterTurn(deps({ get: vi.fn(() => ({ agentGoal: GOAL })) }), "s1", "claude", () => agent);
    await refreshAgentGoalAfterTurn(
      deps({ get: vi.fn(() => ({ agentSessionId: "thread-1", agentGoal: GOAL })) }), "s1", "opencode", () => agent,
    );
    expect(agent.goalCommand).not.toHaveBeenCalled();
  });

  it("does nothing when nothing can answer", async () => {
    const deps = {
      sessionManager: fakeSessions({ get: vi.fn(() => ({ agentSessionId: "thread-1", agentGoal: GOAL })) }) as never,
      sseBroadcast: vi.fn(),
    };
    await expect(refreshAgentGoalAfterTurn(deps, "s1", "claude", () => null)).resolves.toBeUndefined();
  });
});

describe("goalAgentFor (docs/297)", () => {
  const agent = (agentId: string, withGoals = true) => ({
    agentId,
    ...(withGoals ? { goalCommand: vi.fn() } : {}),
  }) as unknown as AgentProcess;

  it("uses the agent the session already has", () => {
    const live = agent("claude");
    const createAgent = vi.fn(() => agent("claude"));
    expect(goalAgentFor({ getAgent: () => live, createAgent }, "claude")).toBe(live);
    expect(createAgent).not.toHaveBeenCalled();
  });

  // Building one would displace the installed proxy and settle its turn again.
  it("leaves an occupied slot alone rather than displacing it", () => {
    const createAgent = vi.fn(() => agent("claude"));
    expect(goalAgentFor({ getAgent: () => agent("codex"), createAgent }, "claude")).toBeNull();
    expect(goalAgentFor({ getAgent: () => agent("claude", false), createAgent }, "claude")).toBeNull();
    expect(createAgent).not.toHaveBeenCalled();
  });

  // A one-shot turn clears the slot before idle, so the read needs a fresh agent.
  it("builds one when the slot is empty, where nothing can be superseded", () => {
    const built = agent("claude");
    const createAgent = vi.fn(() => built);
    expect(goalAgentFor({ getAgent: () => null, createAgent }, "claude")).toBe(built);
    expect(goalAgentFor({ getAgent: () => null }, "claude")).toBeNull();
  });
});

describe("describeGoalResult", () => {
  it("answers each command", () => {
    expect(describeGoalResult({ action: "get" }, GOAL)).toBe("Goal (active): Ship it — 1,200 tokens used");
    expect(describeGoalResult({ action: "get" }, { ...GOAL, status: "budgetLimited", tokensUsed: 0 }))
      .toBe("Goal (stopped at its token budget): Ship it");
    expect(describeGoalResult({ action: "set", objective: "Ship it" }, GOAL)).toBe("Goal set: Ship it");
    expect(describeGoalResult({ action: "pause" }, GOAL)).toBe("Goal paused: Ship it");
    // Measured: a pause does not interrupt the turn in progress, so the notice says so.
    expect(describeGoalResult({ action: "pause" }, GOAL, { turnRunning: true }))
      .toBe("Goal paused: Ship it. The running turn continues; the pause applies from the next turn.");
    expect(describeGoalResult({ action: "resume" }, GOAL)).toBe("Goal resumed: Ship it");
    expect(describeGoalResult({ action: "clear" }, null)).toBe("Goal cleared.");
  });

  it("says so when there is no goal", () => {
    expect(describeGoalResult({ action: "get" }, null)).toBe("No goal is set.");
    expect(describeGoalResult({ action: "pause" }, null)).toBe("No goal is set.");
  });
});
