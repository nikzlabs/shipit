import { describe, it, expect } from "vitest";
import { ridesTurnGoalCommand } from "./agent-execution.js";
import type { AgentCapabilities } from "../../shared/types/agent-types.js";

const claude: Pick<AgentCapabilities, "supportsGoals" | "goalActions"> = {
  supportsGoals: true,
  goalActions: { get: "control", clear: "control", set: "turn" },
};

describe("ridesTurnGoalCommand (docs/297)", () => {
  it("is true only for an action this harness answers with a turn", () => {
    expect(ridesTurnGoalCommand("/goal the suite is green", claude)).toBe(true);
    expect(ridesTurnGoalCommand("/goal", claude)).toBe(false);
    expect(ridesTurnGoalCommand("/goal clear", claude)).toBe(false);
    // Refused, not passed through: the CLI would read "pause" as a condition.
    expect(ridesTurnGoalCommand("/goal pause", claude)).toBe(false);
  });

  it("is looked up per action, not derived from `set`", () => {
    const grokish = { supportsGoals: true, goalActions: { set: "control", resume: "turn" } } as const;
    expect(ridesTurnGoalCommand("/goal ship it", grokish)).toBe(false);
    expect(ridesTurnGoalCommand("/goal resume", grokish)).toBe(true);
  });

  it("is false for ordinary text and for a harness with no goal store", () => {
    expect(ridesTurnGoalCommand("fix the build", claude)).toBe(false);
    expect(ridesTurnGoalCommand("/goal ship it", { supportsGoals: false })).toBe(false);
    expect(ridesTurnGoalCommand("/goal ship it", undefined)).toBe(false);
    // Codex declares no goalActions: everything is answered out of band.
    expect(ridesTurnGoalCommand("/goal ship it", { supportsGoals: true })).toBe(false);
  });
});
