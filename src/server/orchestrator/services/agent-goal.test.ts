import { describe, it, expect, vi } from "vitest";
import { describeGoalResult, recordAgentGoal } from "./agent-goal.js";

const GOAL = { objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 1200, timeUsedSeconds: 5, updatedAt: 1 };

describe("recordAgentGoal", () => {
  it("broadcasts the session list only when the shown goal changed", () => {
    const setAgentGoal = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const sseBroadcast = vi.fn();
    const deps = { sessionManager: { setAgentGoal, list: () => [] }, sseBroadcast };

    recordAgentGoal(deps, "s1", GOAL);
    recordAgentGoal(deps, "s1", { ...GOAL, tokensUsed: 2000 });

    expect(setAgentGoal).toHaveBeenCalledTimes(2);
    expect(sseBroadcast).toHaveBeenCalledTimes(1);
    expect(sseBroadcast).toHaveBeenCalledWith("session_list", { sessions: [] });
  });
});

describe("describeGoalResult", () => {
  it("answers each command", () => {
    expect(describeGoalResult({ action: "get" }, GOAL)).toBe("Goal (active): Ship it — 1,200 tokens used");
    expect(describeGoalResult({ action: "get" }, { ...GOAL, status: "budgetLimited", tokensUsed: 0 }))
      .toBe("Goal (stopped at its token budget): Ship it");
    expect(describeGoalResult({ action: "set", objective: "Ship it" }, GOAL)).toBe("Goal set: Ship it");
    expect(describeGoalResult({ action: "pause" }, GOAL)).toBe("Goal paused: Ship it");
    expect(describeGoalResult({ action: "resume" }, GOAL)).toBe("Goal resumed: Ship it");
    expect(describeGoalResult({ action: "clear" }, null)).toBe("Goal cleared.");
  });

  it("says so when there is no goal", () => {
    expect(describeGoalResult({ action: "get" }, null)).toBe("No goal is set.");
    expect(describeGoalResult({ action: "pause" }, null)).toBe("No goal is set.");
  });
});
