import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type {
  AgentGoal,
  AgentGoalCommand,
  AgentGoalCommandResult,
} from "../../../shared/types/agent-types.js";
import { killProcessTree } from "../../../shared/kill-child.js";

export type GoalRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export function normalizeCodexGoal(raw: unknown): AgentGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.objective !== "string" || typeof g.status !== "string") return null;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    objective: g.objective,
    status: g.status,
    tokenBudget: typeof g.tokenBudget === "number" ? g.tokenBudget : null,
    tokensUsed: num(g.tokensUsed),
    timeUsedSeconds: num(g.timeUsedSeconds),
    updatedAt: num(g.updatedAt),
  };
}

function goalFrom(result: unknown): AgentGoal | null {
  return normalizeCodexGoal((result as { goal?: unknown } | null | undefined)?.goal);
}

/** Shapes measured on codex-cli 0.154.0 — see docs/154 plan.md. */
export async function executeGoalCommand(
  request: GoalRequest,
  threadId: string,
  command: AgentGoalCommand,
): Promise<AgentGoalCommandResult> {
  switch (command.action) {
    case "get":
      return { goal: goalFrom(await request("thread/goal/get", { threadId })) };
    case "set":
      return {
        goal: goalFrom(await request("thread/goal/set", {
          threadId,
          objective: command.objective,
          status: "active",
        })),
      };
    case "clear":
      await request("thread/goal/clear", { threadId });
      return { goal: null };
    case "pause":
    case "resume": {
      // A status-only set has nothing to update when the thread has no goal.
      const current = goalFrom(await request("thread/goal/get", { threadId }));
      if (!current) return { goal: null };
      return {
        goal: goalFrom(await request("thread/goal/set", {
          threadId,
          status: command.action === "pause" ? "paused" : "active",
        })),
      };
    }
  }
}

export const GOAL_CONTROL_TIMEOUT_MS = 15_000;

export interface GoalControlOptions {
  threadId: string;
  command: AgentGoalCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnProcess?: (args: string[], opts: SpawnOptions) => ChildProcess;
}

/**
 * Run one goal command in a short-lived app-server, for when no turn is live.
 * It never calls `thread/resume`: on 0.154.0 a resume with an active goal starts
 * a continuation turn, while goal requests on an unloaded thread start nothing.
 */
export async function runCodexGoalControl(opts: GoalControlOptions): Promise<AgentGoalCommandResult> {
  const spawnProcess = opts.spawnProcess ?? ((args, spawnOpts) => spawn("codex", args, spawnOpts));
  const proc = spawnProcess(["app-server"], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  const failAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      // Notifications and server requests are not answers to our requests.
      if (typeof msg.id !== "number" || typeof msg.method === "string") continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "JSON-RPC error"));
      else p.resolve(msg.result);
    }
  });
  proc.stdin?.on("error", () => { /* surfaced by close */ });
  proc.on("error", (err) => { failAll(err); });
  proc.on("close", (code) => {
    failAll(new Error(`codex app-server exited (${code ?? "signal"}) before answering`));
  });

  const request: GoalRequest = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await request("initialize", { clientInfo: { name: "shipit", title: "ShipIt IDE", version: "1.0.0" } });
      proc.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
      return executeGoalCommand(request, opts.threadId, opts.command);
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("codex app-server did not answer the goal request in time"));
      }, opts.timeoutMs ?? GOAL_CONTROL_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    killProcessTree(proc, "SIGTERM", { label: "codex-goal" });
  }
}
