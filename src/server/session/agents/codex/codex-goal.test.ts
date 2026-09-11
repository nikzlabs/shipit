import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { executeGoalCommand, normalizeCodexGoal, runCodexGoalControl } from "./codex-goal.js";

// Recorded from codex-cli 0.154.0 (docs/154 plan.md, "Measured").
const GOAL = {
  threadId: "t1",
  objective: "Ship it",
  status: "active",
  tokenBudget: null,
  tokensUsed: 12,
  timeUsedSeconds: 3,
  createdAt: 1789140440,
  updatedAt: 1789140441,
};

function recorder(responses: Record<string, unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params });
    return responses[method];
  };
  return { calls, request };
}

describe("normalizeCodexGoal", () => {
  it("keeps what ShipIt shows and drops the thread id", () => {
    expect(normalizeCodexGoal(GOAL)).toEqual({
      objective: "Ship it",
      status: "active",
      tokenBudget: null,
      tokensUsed: 12,
      timeUsedSeconds: 3,
      updatedAt: 1789140441,
    });
  });

  it("rejects a shape without an objective or status", () => {
    expect(normalizeCodexGoal(null)).toBeNull();
    expect(normalizeCodexGoal({ goal: null })).toBeNull();
    expect(normalizeCodexGoal({ objective: "x" })).toBeNull();
  });
});

describe("executeGoalCommand", () => {
  it("get reads thread/goal/get", async () => {
    const { calls, request } = recorder({ "thread/goal/get": { goal: GOAL } });
    const result = await executeGoalCommand(request, "t1", { action: "get" });
    expect(calls).toEqual([{ method: "thread/goal/get", params: { threadId: "t1" } }]);
    expect(result.goal?.objective).toBe("Ship it");
  });

  it("get reports no goal", async () => {
    const { request } = recorder({ "thread/goal/get": { goal: null } });
    expect(await executeGoalCommand(request, "t1", { action: "get" })).toEqual({ goal: null });
  });

  it("set creates an active goal", async () => {
    const { calls, request } = recorder({ "thread/goal/set": { goal: GOAL } });
    const result = await executeGoalCommand(request, "t1", { action: "set", objective: "Ship it" });
    expect(calls).toEqual([{
      method: "thread/goal/set",
      params: { threadId: "t1", objective: "Ship it", status: "active" },
    }]);
    expect(result.goal?.status).toBe("active");
  });

  it("clear calls thread/goal/clear", async () => {
    const { calls, request } = recorder({ "thread/goal/clear": { cleared: true } });
    expect(await executeGoalCommand(request, "t1", { action: "clear" })).toEqual({ goal: null });
    expect(calls.map((c) => c.method)).toEqual(["thread/goal/clear"]);
  });

  it("pause and resume set only the status of an existing goal", async () => {
    const paused = recorder({ "thread/goal/get": { goal: GOAL }, "thread/goal/set": { goal: { ...GOAL, status: "paused" } } });
    expect((await executeGoalCommand(paused.request, "t1", { action: "pause" })).goal?.status).toBe("paused");
    expect(paused.calls[1]).toEqual({ method: "thread/goal/set", params: { threadId: "t1", status: "paused" } });

    const resumed = recorder({ "thread/goal/get": { goal: GOAL }, "thread/goal/set": { goal: GOAL } });
    await executeGoalCommand(resumed.request, "t1", { action: "resume" });
    expect(resumed.calls[1]).toEqual({ method: "thread/goal/set", params: { threadId: "t1", status: "active" } });
  });

  it("pause does nothing when the thread has no goal", async () => {
    const { calls, request } = recorder({ "thread/goal/get": { goal: null } });
    expect(await executeGoalCommand(request, "t1", { action: "pause" })).toEqual({ goal: null });
    expect(calls.map((c) => c.method)).toEqual(["thread/goal/get"]);
  });
});

class FakeStdin extends EventEmitter {
  lines: { id?: number; method: string; params?: Record<string, unknown> }[] = [];
  constructor(private readonly onRequest: (msg: { id?: number; method: string }) => void) {
    super();
  }
  write(data: string): boolean {
    const msg = JSON.parse(data.trim()) as { id?: number; method: string; params?: Record<string, unknown> };
    this.lines.push(msg);
    setImmediate(() => { this.onRequest(msg); });
    return true;
  }
}

class FakeControlProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: FakeStdin;
  // No pid: killProcessTree treats this as a failed spawn and signals nothing real.
  pid = undefined;
  exitCode = null;
  signalCode = null;
  constructor(answer: (msg: { id?: number; method: string }, proc: FakeControlProcess) => void) {
    super();
    this.stdin = new FakeStdin((msg) => { answer(msg, this); });
  }
  reply(id: number, body: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({ id, ...body })}\n`));
  }
}

function spawnWith(answer: (msg: { id?: number; method: string }, proc: FakeControlProcess) => void) {
  const spawned: { args: string[]; opts: SpawnOptions; proc: FakeControlProcess }[] = [];
  const spawnProcess = vi.fn((args: string[], opts: SpawnOptions) => {
    const proc = new FakeControlProcess(answer);
    spawned.push({ args, opts, proc });
    return proc as unknown as ChildProcess;
  });
  return { spawned, spawnProcess };
}

describe("runCodexGoalControl", () => {
  const answers: Record<string, Record<string, unknown>> = {
    initialize: { result: {} },
    "thread/goal/clear": { result: { cleared: true } },
    "thread/goal/get": { result: { goal: GOAL } },
  };

  it("initializes, runs the goal request, and never resumes the thread", async () => {
    const { spawned, spawnProcess } = spawnWith((msg, proc) => {
      if (msg.id !== undefined) proc.reply(msg.id, answers[msg.method] ?? { result: {} });
    });
    const result = await runCodexGoalControl({
      threadId: "t1",
      command: { action: "clear" },
      cwd: "/tmp",
      env: { CODEX_HOME: "/home/x/.codex" },
      spawnProcess,
    });

    expect(result).toEqual({ goal: null });
    expect(spawned[0].args).toEqual(["app-server"]);
    expect(spawned[0].opts.env?.CODEX_HOME).toBe("/home/x/.codex");
    expect(spawned[0].proc.stdin.lines.map((l) => l.method)).toEqual(["initialize", "initialized", "thread/goal/clear"]);
  });

  it("ignores notifications while it waits for its answer", async () => {
    const { spawnProcess } = spawnWith((msg, proc) => {
      if (msg.method === "thread/goal/get") {
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ method: "thread/goal/updated", params: { goal: GOAL } })}\n`));
      }
      if (msg.id !== undefined) proc.reply(msg.id, answers[msg.method] ?? { result: {} });
    });
    const result = await runCodexGoalControl({ threadId: "t1", command: { action: "get" }, cwd: "/tmp", env: {}, spawnProcess });
    expect(result.goal?.objective).toBe("Ship it");
  });

  it("rejects with the app-server's error message", async () => {
    const { spawnProcess } = spawnWith((msg, proc) => {
      if (msg.id === undefined) return;
      if (msg.method === "initialize") proc.reply(msg.id, { result: {} });
      else proc.reply(msg.id, { error: { code: -32600, message: "thread not found: t1" } });
    });
    await expect(runCodexGoalControl({ threadId: "t1", command: { action: "get" }, cwd: "/tmp", env: {}, spawnProcess }))
      .rejects.toThrow("thread not found: t1");
  });

  it("rejects when the app-server exits before it answers", async () => {
    const { spawnProcess } = spawnWith((_msg, proc) => { proc.emit("close", 1); });
    await expect(runCodexGoalControl({ threadId: "t1", command: { action: "get" }, cwd: "/tmp", env: {}, spawnProcess }))
      .rejects.toThrow("exited (1)");
  });

  it("rejects when the app-server never answers", async () => {
    const { spawnProcess } = spawnWith(() => { /* silent */ });
    await expect(runCodexGoalControl({
      threadId: "t1", command: { action: "get" }, cwd: "/tmp", env: {}, spawnProcess, timeoutMs: 20,
    })).rejects.toThrow("did not answer");
  });
});
