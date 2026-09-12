// Answers captured from `@xai-official/grok` 1.0.18 on 2026-09-12 — see docs/298-goal-on-grok/plan.md.
import { describe, it, expect, vi } from "vitest";
import { executeGrokGoalCommand, parseElapsedSeconds, parseGrokGoalAnswer } from "./grok-goal.js";

const NO_GOAL_STATUS = "No goal is currently set. Use /goal <objective> to start one.";
const NO_GOAL_PAUSE = "No goal is currently set.";
const NO_GOAL_RESUME = "No goal set. Use /goal <objective> to start one.";
const CLEARED = "Goal cleared.";
const REPORT = [
  "Goal: Create three text files a.txt, b.txt and c.txt in the working directory, each containing its own file name",
  "Status: UserPaused | Phase: Idle",
  "Goal tokens used: 251386",
  "Elapsed: 4m39s",
].join("\n");
const ACTIVE_REPORT = ["Goal: stop", "Status: Active | Phase: Executing", "Goal tokens used: 38100", "Elapsed: 35s"].join("\n");

describe("parseGrokGoalAnswer", () => {
  it.each([NO_GOAL_STATUS, NO_GOAL_PAUSE, NO_GOAL_RESUME])("reads %s as no goal", (text) => {
    expect(parseGrokGoalAnswer(text)).toEqual({ kind: "none" });
  });

  it("reads the clear acknowledgement", () => {
    expect(parseGrokGoalAnswer(CLEARED)).toEqual({ kind: "cleared" });
  });

  it("reads the report into an AgentGoal, with the CLI's own status word normalized", () => {
    expect(parseGrokGoalAnswer(REPORT, 1_700_000_000_000)).toEqual({
      kind: "goal",
      goal: {
        objective: "Create three text files a.txt, b.txt and c.txt in the working directory, each containing its own file name",
        status: "user_paused",
        tokenBudget: null,
        tokensUsed: 251386,
        timeUsedSeconds: 279,
        updatedAt: 1_700_000_000,
      },
    });
  });

  it("keeps a multi-line objective whole", () => {
    const answer = parseGrokGoalAnswer(`Goal: first line\nsecond line\nStatus: Active | Phase: Idle\nGoal tokens used: 0\nElapsed: 0s`);
    expect(answer).toMatchObject({ kind: "goal", goal: { objective: "first line\nsecond line", status: "active" } });
  });

  it("reads a status line with no phase", () => {
    expect(parseGrokGoalAnswer("Goal: ship it\nStatus: BudgetLimited")).toMatchObject({
      goal: { status: "budget_limited", tokensUsed: 0, timeUsedSeconds: 0 },
    });
  });

  // An answer read as "no goal" would clear the chip and hide a goal that is still loaded.
  it.each([
    "Goal is already paused.",
    "Goal is already complete. Use /goal <objective> to start a new one.",
    "Something the CLI started saying in a later version",
    "",
  ])("reports %s as unknown rather than as no goal", (text) => {
    expect(parseGrokGoalAnswer(text)).toEqual({ kind: "unknown" });
  });
});

describe("parseElapsedSeconds", () => {
  it.each([
    ["4m39s", 279],
    ["35s", 35],
    ["2h3m4s", 7384],
    ["1d2h3m4s", 93_784],
    ["", 0],
    ["a while", 0],
  ])("reads %s as %i seconds", (text, expected) => {
    expect(parseElapsedSeconds(text)).toBe(expected);
  });
});

function runner(answers: Record<string, string>): { run: (p: string) => Promise<string>; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    run: vi.fn((prompt: string) => {
      prompts.push(prompt);
      const answer = answers[prompt];
      if (answer === undefined) throw new Error(`unexpected prompt: ${prompt}`);
      return Promise.resolve(answer);
    }),
  };
}

describe("executeGrokGoalCommand", () => {
  it("reads the goal with one /goal status", async () => {
    const r = runner({ "/goal status": REPORT });
    await expect(executeGrokGoalCommand(r.run, { action: "get" })).resolves.toMatchObject({
      goal: { objective: expect.stringContaining("three text files") as string },
    });
    expect(r.prompts).toEqual(["/goal status"]);
  });

  it("reports no goal when the CLI says so", async () => {
    const r = runner({ "/goal status": NO_GOAL_STATUS });
    await expect(executeGrokGoalCommand(r.run, { action: "get" })).resolves.toEqual({ goal: null });
  });

  it("fails a read it cannot understand instead of reporting no goal", async () => {
    const r = runner({ "/goal status": "Goal mode is off." });
    await expect(executeGrokGoalCommand(r.run, { action: "get" })).rejects.toThrow(/not recognised/);
  });

  // The pause answer names no goal, so the chip would lose the objective without the re-read.
  it("re-reads the status after a pause", async () => {
    const r = runner({ "/goal pause": "Goal is already paused.", "/goal status": REPORT });
    await expect(executeGrokGoalCommand(r.run, { action: "pause" })).resolves.toMatchObject({
      goal: { status: "user_paused" },
    });
    expect(r.prompts).toEqual(["/goal pause", "/goal status"]);
  });

  it("fails a pause the CLI did not apply", async () => {
    const r = runner({ "/goal pause": "Goal paused.", "/goal status": ACTIVE_REPORT });
    await expect(executeGrokGoalCommand(r.run, { action: "pause" })).rejects.toThrow(/still reports the goal as active/);
  });

  it("pauses a session that has no goal without failing", async () => {
    const r = runner({ "/goal pause": NO_GOAL_PAUSE, "/goal status": NO_GOAL_STATUS });
    await expect(executeGrokGoalCommand(r.run, { action: "pause" })).resolves.toEqual({ goal: null });
  });

  // Measured: a clear can answer "Goal cleared." and leave the goal loaded.
  it("confirms a clear with a second read", async () => {
    const r = runner({ "/goal clear": CLEARED, "/goal status": NO_GOAL_STATUS });
    await expect(executeGrokGoalCommand(r.run, { action: "clear" })).resolves.toEqual({ goal: null });
    expect(r.prompts).toEqual(["/goal clear", "/goal status"]);
  });

  it("fails a clear the CLI did not apply", async () => {
    const r = runner({ "/goal clear": CLEARED, "/goal status": REPORT });
    await expect(executeGrokGoalCommand(r.run, { action: "clear" })).rejects.toThrow(/run \/goal clear again/);
  });

  it.each(["set", "resume"] as const)("refuses %s, which runs the agent and belongs in a turn", async (action) => {
    const r = runner({});
    const command = action === "set" ? { action, objective: "x" } as const : { action } as const;
    await expect(executeGrokGoalCommand(r.run, command)).rejects.toThrow(/inside a turn/);
    expect(r.prompts).toEqual([]);
  });
});
