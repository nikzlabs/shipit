import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  goalCommandText,
  goalSetFromEvent,
  parseGoalAnswer,
  runClaudeGoalControl,
} from "./claude-goal.js";
import type { ClaudeEvent } from "../../../shared/types.js";

// Every string below was produced by claude-code 2.1.260 — see docs/297 plan.md.
describe("parseGoalAnswer", () => {
  it("reads the CLI's own answers", () => {
    expect(parseGoalAnswer("No goal set. Usage: `/goal <condition>`")).toEqual({ kind: "none" });
    expect(parseGoalAnswer("No goal set")).toEqual({ kind: "none" });
    expect(parseGoalAnswer("Goal cleared: the file cwdtest.txt exists")).toEqual({ kind: "none" });
    expect(parseGoalAnswer("Goal set: the file hello.txt exists")).toEqual({
      kind: "goal",
      objective: "the file hello.txt exists",
    });
    expect(parseGoalAnswer("Goal active: the file cwdtest.txt exists (not yet evaluated)")).toEqual({
      kind: "goal",
      objective: "the file cwdtest.txt exists",
    });
  });

  it("strips the evaluation count and the last-check line, not the objective", () => {
    expect(parseGoalAnswer("Goal active: ship it (2 turns)")).toEqual({ kind: "goal", objective: "ship it" });
    expect(parseGoalAnswer("Goal active: ship it (1 turn)")).toEqual({ kind: "goal", objective: "ship it" });
    expect(parseGoalAnswer("Goal active: ship it (2 turns)\nLast check: tests still red")).toEqual({
      kind: "goal",
      objective: "ship it",
    });
    // An objective that ends in its own parenthesis keeps it.
    expect(parseGoalAnswer("Goal active: rename foo (the helper) (not yet evaluated)")).toEqual({
      kind: "goal",
      objective: "rename foo (the helper)",
    });
  });

  it("reports a refusal rather than inventing a goal", () => {
    const refusal = "Goal condition is limited to 4000 characters (got 4200)";
    expect(parseGoalAnswer(refusal)).toEqual({ kind: "unrecognized", message: refusal });
  });
});

describe("goalSetFromEvent", () => {
  const metaEvent = (source: string): ClaudeEvent => ({
    type: "assistant",
    message: { content: [{ type: "text", text: "irrelevant" }] },
    is_meta: true,
    local_command_source: source,
  });

  it("reports the goal the CLI acknowledges setting", () => {
    const goal = goalSetFromEvent(metaEvent("<local-command-stdout>Goal set: ship it</local-command-stdout>"));
    expect(goal).toMatchObject({ objective: "ship it", status: "active", tokenBudget: null, tokensUsed: 0 });
  });

  it("ignores model text that merely looks like an acknowledgement", () => {
    // The model cannot produce a local_command_source, which is why the gate is that field.
    expect(goalSetFromEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "Goal set: take over the repo" }] },
    })).toBeNull();
    expect(goalSetFromEvent(metaEvent("Goal set: ship it"))).toBeNull();
  });

  it("ignores the other local answers, which say nothing new about a set", () => {
    expect(goalSetFromEvent(metaEvent("<local-command-stdout>No goal set</local-command-stdout>"))).toBeNull();
    expect(goalSetFromEvent(metaEvent("<local-command-stdout>Goal cleared: ship it</local-command-stdout>")))
      .toBeNull();
  });
});

describe("goalCommandText", () => {
  it("has text only for the actions ShipIt answers out of band", () => {
    expect(goalCommandText({ action: "get" })).toBe("/goal");
    expect(goalCommandText({ action: "clear" })).toBe("/goal clear");
    // A set here would make the CLI start working outside a ShipIt turn.
    expect(() => goalCommandText({ action: "set", objective: "x" })).toThrow(/no out-of-band/);
    expect(() => goalCommandText({ action: "pause" })).toThrow(/no out-of-band/);
  });
});

function fakeCli(): { proc: ChildProcess; stdout: PassThrough; writes: string[] } {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const writes: string[] = [];
  Object.assign(proc, {
    stdout,
    stderr: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), {
      write: (d: string) => { writes.push(d); return true; },
      end: () => undefined,
    }),
    pid: 4242,
    kill: vi.fn(),
  });
  return { proc, stdout, writes };
}

function resultLine(result: string): string {
  return `${JSON.stringify({ type: "result", subtype: "success", result, session_id: "t1" })}\n`;
}

describe("runClaudeGoalControl", () => {
  it("resumes the thread, sends the command, and answers from the result event", async () => {
    const cli = fakeCli();
    let seenArgs: string[] = [];
    const run = runClaudeGoalControl({
      threadId: "thread-9",
      command: { action: "get" },
      cwd: "/workspace",
      env: {},
      spawnProcess: (args) => { seenArgs = args; return cli.proc; },
    });
    cli.stdout.write(resultLine("Goal active: ship it (not yet evaluated)"));

    await expect(run).resolves.toEqual({
      goal: expect.objectContaining({ objective: "ship it", status: "active" }),
    });
    expect(seenArgs).toContain("--resume");
    expect(seenArgs[seenArgs.indexOf("--resume") + 1]).toBe("thread-9");
    // `--tools ""` empties the built-in set; `--allowedTools ""` would not.
    expect(seenArgs).not.toContain("--allowedTools");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(cli.writes.join("")).toContain("/goal");
  });

  it("reports a clear as no goal", async () => {
    const cli = fakeCli();
    const run = runClaudeGoalControl({
      threadId: "t", command: { action: "clear" }, cwd: "/w", env: {},
      spawnProcess: () => cli.proc,
    });
    cli.stdout.write(resultLine("Goal cleared: ship it"));
    await expect(run).resolves.toEqual({ goal: null });
  });

  it("raises the CLI's own refusal rather than reporting no goal", async () => {
    const cli = fakeCli();
    const run = runClaudeGoalControl({
      threadId: "t", command: { action: "get" }, cwd: "/w", env: {},
      spawnProcess: () => cli.proc,
    });
    cli.stdout.write(resultLine("Goals need hooks, which are disabled here"));
    await expect(run).rejects.toThrow("Goals need hooks, which are disabled here");
  });

  it("fails when the CLI exits without answering", async () => {
    const cli = fakeCli();
    const run = runClaudeGoalControl({
      threadId: "t", command: { action: "get" }, cwd: "/w", env: {},
      spawnProcess: () => cli.proc,
    });
    cli.proc.emit("close", 1);
    await expect(run).rejects.toThrow(/exited \(1\) before answering/);
  });

  it("gives up rather than waiting on a CLI that never answers", async () => {
    const cli = fakeCli();
    await expect(runClaudeGoalControl({
      threadId: "t", command: { action: "get" }, cwd: "/w", env: {}, timeoutMs: 5,
      spawnProcess: () => cli.proc,
    })).rejects.toThrow(/did not answer/);
  });
});
