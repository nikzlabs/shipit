import { describe, it, expect } from "vitest";
import { goalSlashCommands } from "./MessageInput.js";

describe("goalSlashCommands (docs/297 req 5)", () => {
  it("offers the whole vocabulary when the harness declares no restriction", () => {
    expect(goalSlashCommands(undefined).map((c) => c.name)).toEqual([
      "goal", "goal clear", "goal pause", "goal resume",
    ]);
  });

  it("drops pause and resume for a harness that has neither", () => {
    const commands = goalSlashCommands({ get: "control", clear: "control", set: "turn" });
    expect(commands.map((c) => c.name)).toEqual(["goal", "goal clear"]);
    expect(commands[0].description).toMatch(/\/goal <objective> to set one/);
  });

  it("stops promising a set the harness cannot do", () => {
    const commands = goalSlashCommands({ get: "control" });
    expect(commands.map((c) => c.name)).toEqual(["goal"]);
    expect(commands[0].description).toBe("Show the goal");
  });
});
