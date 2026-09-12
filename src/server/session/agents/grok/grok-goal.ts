import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type {
  AgentGoal,
  AgentGoalCommand,
  AgentGoalCommandResult,
} from "../../../shared/types/agent-types.js";
import { killProcessTree } from "../../../shared/kill-child.js";
import { parseGrokLine } from "./stream.js";

/** docs/298 — Grok answers in prose, so an answer it does not recognise is never read as "no goal". */
export type GrokGoalAnswer =
  | { kind: "none" }
  | { kind: "cleared" }
  | { kind: "goal"; goal: AgentGoal }
  | { kind: "unknown" };

const NO_GOAL = /^no goal (?:is currently set|set)\b/i;
const CLEARED = /^goal cleared\b/i;
const REPORT = /^Goal:\s*([\s\S]*?)\r?\nStatus:\s*([^|\r\n]+?)(?:\s*\|\s*Phase:.*)?(?:\r?\n|$)/;

/** `4m39s`, `2h3m4s`, `45s`, `1d2h3m4s`. */
export function parseElapsedSeconds(text: string): number {
  const m = /^\s*(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$/.exec(text);
  if (!m || m.slice(1).every((g) => g === undefined)) return 0;
  const [d, h, min, s] = m.slice(1).map((g) => (g ? Number(g) : 0));
  return d * 86_400 + h * 3_600 + min * 60 + s;
}

// The report prints the Rust variant name; state.json and `goal_updated` use snake_case.
// One vocabulary means one label map covers every surface.
function normalizeStatus(word: string): string {
  return word
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function numberAfter(text: string, label: RegExp): number | null {
  const m = label.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/[,_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseGrokGoalAnswer(raw: string, now = Date.now()): GrokGoalAnswer {
  const text = raw.trim();
  if (!text) return { kind: "unknown" };
  if (NO_GOAL.test(text)) return { kind: "none" };
  if (CLEARED.test(text)) return { kind: "cleared" };

  const m = REPORT.exec(text);
  if (!m) return { kind: "unknown" };
  const objective = m[1].trim();
  if (!objective) return { kind: "unknown" };
  const elapsed = /^Elapsed:\s*(.+)$/m.exec(text);
  return {
    kind: "goal",
    goal: {
      objective,
      status: normalizeStatus(m[2]),
      // Grok's report carries no budget; a budget-limited goal is named by its status instead.
      tokenBudget: null,
      tokensUsed: numberAfter(text, /^Goal tokens used:\s*([\d,_ ]+)$/m) ?? 0,
      timeUsedSeconds: elapsed ? parseElapsedSeconds(elapsed[1]) : 0,
      updatedAt: Math.floor(now / 1000),
    },
  };
}

const PAUSED = /_?paused$/;

export type GrokGoalRun = (prompt: string) => Promise<string>;

function goalOrThrow(answer: GrokGoalAnswer, what: string): AgentGoal | null {
  if (answer.kind === "goal") return answer.goal;
  if (answer.kind === "unknown") throw new Error(`Grok's answer to ${what} was not recognised`);
  return null;
}

/**
 * docs/298 — only the actions measured to need no model call run here. `set` and
 * `resume` re-enter Grok's planner and verifier, so they ride a turn instead.
 * `pause` and `clear` re-read the status, because their own answers name no goal
 * and a clear can fail while still printing "Goal cleared.".
 */
export async function executeGrokGoalCommand(
  run: GrokGoalRun,
  command: AgentGoalCommand,
): Promise<AgentGoalCommandResult> {
  switch (command.action) {
    case "get":
      return { goal: goalOrThrow(parseGrokGoalAnswer(await run("/goal status")), "/goal status") };
    case "pause": {
      await run("/goal pause");
      const goal = goalOrThrow(parseGrokGoalAnswer(await run("/goal status")), "/goal status");
      if (goal && !PAUSED.test(goal.status)) {
        throw new Error(`Grok still reports the goal as ${goal.status}`);
      }
      return { goal };
    }
    case "clear": {
      const answer = parseGrokGoalAnswer(await run("/goal clear"));
      if (answer.kind === "unknown") throw new Error("Grok's answer to /goal clear was not recognised");
      const after = goalOrThrow(parseGrokGoalAnswer(await run("/goal status")), "/goal status");
      if (after) throw new Error("Grok still reports a goal; run /goal clear again");
      return { goal: null };
    }
    default:
      throw new Error(`Grok runs /goal ${command.action} inside a turn, so ShipIt does not answer it`);
  }
}

export const GOAL_CONTROL_TIMEOUT_MS = 15_000;

export interface GrokGoalControlOptions {
  threadId: string;
  command: AgentGoalCommand;
  cwd: string;
  home: string;
  configRoot: string;
  binary: string;
  timeoutMs?: number;
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
}

/**
 * One short-lived `grok` per prompt. `plan` rather than `--always-approve`: the
 * prompts are local slash commands that run no tools, and a future CLI that stops
 * recognising one would otherwise send it to the model with every permission.
 */
function runOneGoalPrompt(opts: GrokGoalControlOptions, prompt: string, deadline: number): Promise<string> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const promptPath = path.join(os.tmpdir(), `grok-goal-${randomUUID()}.txt`);
  fs.writeFileSync(promptPath, prompt);

  const proc = spawnFn(opts.binary, [
    "--output-format", "streaming-messages-json",
    "--no-auto-update",
    "--trust",
    "--cwd", opts.cwd,
    "-r", opts.threadId,
    "--permission-mode", "plan",
    "--prompt-file", promptPath,
  ], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      HOME: opts.home,
      GROK_HOME: opts.configRoot,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      DISABLE_TELEMETRY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let result: string | null = null;
    let failure: string | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("the Grok CLI did not answer the goal command in time"));
    }, Math.max(0, deadline - Date.now()));

    // A timeout and the close that follows the kill both land here.
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(promptPath); } catch { /* already gone */ }
      killProcessTree(proc, "SIGTERM", { label: "grok-goal" });
      if (err) reject(err);
      else if (failure) reject(new Error(failure));
      else if (result === null) reject(new Error("the Grok CLI produced no answer to the goal command"));
      else resolve(result);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseGrokLine(line);
        if (event?.type !== "result") continue;
        if (event.is_error === true) failure = event.errors?.join("; ") ?? "the Grok CLI reported an error";
        else if (typeof event.result === "string") result = event.result;
      }
    });
    proc.on("error", (err) => { finish(err); });
    proc.on("close", () => { finish(null); });
  });
}

/** One budget for the whole command, so a two-prompt clear cannot outlast the orchestrator's wait. */
export function runGrokGoalControl(opts: GrokGoalControlOptions): Promise<AgentGoalCommandResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? GOAL_CONTROL_TIMEOUT_MS);
  return executeGrokGoalCommand((prompt) => runOneGoalPrompt(opts, prompt, deadline), opts.command);
}
