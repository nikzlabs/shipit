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

  it("returns browser activity labels for known Playwright MCP tools", () => {
    expect(activityFromTool("mcp__playwright__browser_navigate", {})).toEqual({
      label: "Navigating to page",
      tool: "mcp__playwright__browser_navigate",
    });
    expect(activityFromTool("mcp__playwright__browser_snapshot", {})).toEqual({
      label: "Reading page content",
      tool: "mcp__playwright__browser_snapshot",
    });
    expect(activityFromTool("mcp__playwright__browser_click", {})).toEqual({
      label: "Clicking element",
      tool: "mcp__playwright__browser_click",
    });
    expect(activityFromTool("mcp__playwright__browser_take_screenshot", {})).toEqual({
      label: "Taking screenshot",
      tool: "mcp__playwright__browser_take_screenshot",
    });
  });

  it("returns generic label for unknown MCP tools", () => {
    expect(activityFromTool("mcp__foo__bar_baz", {})).toEqual({
      label: "Using bar baz...",
      tool: "mcp__foo__bar_baz",
    });
  });
});
