import { describe, it, expect } from "vitest";
import { activityFromTool } from "./StreamingIndicator.js";

describe("activityFromTool", () => {
  it("returns Task label with description", () => {
    const result = activityFromTool("Task", { subagent_type: "Plan", description: "Plan approach" });
    expect(result).toEqual({ label: "Task: Plan approach", tool: "Task" });
  });

  it("returns fallback label for Task without description", () => {
    const result = activityFromTool("Task", { subagent_type: "Code" });
    expect(result).toEqual({ label: "Running task...", tool: "Task" });
  });

  it("returns skill label for Skill tool", () => {
    const result = activityFromTool("Skill", { skill: "commit" });
    expect(result).toEqual({ label: "Running skill: commit...", tool: "Skill" });
  });

  it("returns fallback for Skill without skill name", () => {
    const result = activityFromTool("Skill", {});
    expect(result).toEqual({ label: "Running skill: unknown...", tool: "Skill" });
  });
});
