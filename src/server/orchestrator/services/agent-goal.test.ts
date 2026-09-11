import { describe, it, expect, vi } from "vitest";
import {
  describeGoalResult,
  recordAgentGoal,
  recordGoalForThread,
  reconcileAgentGoal,
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
    await reconcileAgentGoal(deps({}), "s1", "claude", createAgent);
    expect(createAgent).not.toHaveBeenCalled();
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
