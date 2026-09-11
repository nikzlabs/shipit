import { describe, it, expect } from "vitest";
import { isGoalCommand, parseGoalCommand } from "./goal-command.js";

describe("parseGoalCommand (docs/154 req 3)", () => {
  it("reads the keywords", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "get" });
    expect(parseGoalCommand("  /goal status ")).toEqual({ action: "get" });
    expect(parseGoalCommand("/goal clear")).toEqual({ action: "clear" });
    expect(parseGoalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(parseGoalCommand("/goal resume")).toEqual({ action: "resume" });
  });

  it("takes any other text as the objective, including several lines", () => {
    expect(parseGoalCommand("/goal make the suite green")).toEqual({ action: "set", objective: "make the suite green" });
    expect(parseGoalCommand("/goal line one\nline two")).toEqual({ action: "set", objective: "line one\nline two" });
    expect(parseGoalCommand("/goal clear the cache")).toEqual({ action: "set", objective: "clear the cache" });
  });

  it("does not match other text", () => {
    expect(isGoalCommand("/goals")).toBe(false);
    expect(isGoalCommand("set a /goal")).toBe(false);
    expect(isGoalCommand("/compact")).toBe(false);
  });
});
