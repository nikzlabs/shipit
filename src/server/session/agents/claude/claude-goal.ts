import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type {
  AgentGoal,
  AgentGoalCommand,
  AgentGoalCommandResult,
} from "../../../shared/types/agent-types.js";
import { killProcessTree } from "../../../shared/kill-child.js";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import type { ClaudeEvent } from "../../../shared/types.js";

/** The CLI prints its goal answers through this wrapper; the model cannot produce one. */
const LOCAL_COMMAND_STDOUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

const SET_PREFIX = "Goal set: ";
const ACTIVE_PREFIX = "Goal active: ";
const CLEARED_PREFIX = "Goal cleared: ";
const NO_GOAL_PREFIX = "No goal set";

// `Goal active: <condition> (not yet evaluated|N turns)` plus an optional last-check line.
const ACTIVE_SUFFIX = /\s*\((?:not yet evaluated|\d+ turns?)\)$/;
const LAST_CHECK = "\nLast check: ";

export type ClaudeGoalAnswer =
  | { kind: "goal"; objective: string }
  | { kind: "none" }
  | { kind: "unrecognized"; message: string };

/**
 * Map one `/goal` answer to a goal. Shapes measured on claude-code 2.1.260 and
 * read out of the binary's own handler — see docs/297 plan.md. Anything else is
 * the CLI refusing (hooks disabled, untrusted directory, condition too long).
 */
export function parseGoalAnswer(raw: string): ClaudeGoalAnswer {
  const text = raw.trim();
  if (text.startsWith(NO_GOAL_PREFIX) || text.startsWith(CLEARED_PREFIX)) return { kind: "none" };
  if (text.startsWith(SET_PREFIX)) {
    return objectiveAnswer(text.slice(SET_PREFIX.length));
  }
  if (text.startsWith(ACTIVE_PREFIX)) {
    const body = text.slice(ACTIVE_PREFIX.length);
    const lastCheck = body.lastIndexOf(LAST_CHECK);
    const withoutCheck = lastCheck === -1 ? body : body.slice(0, lastCheck);
    return objectiveAnswer(withoutCheck.replace(ACTIVE_SUFFIX, ""));
  }
  return { kind: "unrecognized", message: text };
}

function objectiveAnswer(objective: string): ClaudeGoalAnswer {
  const trimmed = objective.trim();
  return trimmed ? { kind: "goal", objective: trimmed } : { kind: "none" };
}

/** Claude Code tracks no budget or usage against a goal; `status` stays its own word. */
export function claudeGoal(objective: string, now = Date.now()): AgentGoal {
  return {
    objective,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: Math.floor(now / 1000),
  };
}

export function goalFromAnswer(answer: ClaudeGoalAnswer): AgentGoal | null {
  if (answer.kind === "goal") return claudeGoal(answer.objective);
  if (answer.kind === "none") return null;
  throw new Error(answer.message);
}

/**
 * The CLI answering a `/goal` locally, which only it can produce: an assistant
 * message the model wrote has neither `is_meta` nor a `local_command_source`.
 */
export function localGoalAnswer(event: ClaudeEvent): ClaudeGoalAnswer | null {
  if (event.type !== "assistant" || event.is_meta !== true) return null;
  const source = event.local_command_source;
  if (typeof source !== "string") return null;
  const inner = LOCAL_COMMAND_STDOUT.exec(source.trim());
  return inner ? parseGoalAnswer(inner[1]) : null;
}

/** The set acknowledgement is the only goal signal an unprompted stream carries (docs/297). */
export function goalSetFromEvent(event: ClaudeEvent): AgentGoal | null {
  if (event.type !== "assistant" || typeof event.local_command_source !== "string") return null;
  if (!event.local_command_source.includes(SET_PREFIX)) return null;
  const answer = localGoalAnswer(event);
  return answer?.kind === "goal" ? claudeGoal(answer.objective) : null;
}

/** The CLI's own `/goal` text for a command ShipIt answers out of band. */
export function goalCommandText(command: AgentGoalCommand): string {
  switch (command.action) {
    case "get":
      return "/goal";
    case "clear":
      return "/goal clear";
    default:
      // `set` starts CLI work at once, so it rides the turn; pause and resume do
      // not exist. Both are refused before the adapter, and again here.
      throw new Error(`Claude Code has no out-of-band /goal ${command.action}`);
  }
}

export const GOAL_CONTROL_TIMEOUT_MS = 15_000;

export interface ClaudeGoalControlOptions {
  threadId: string;
  command: AgentGoalCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnProcess?: (args: string[], opts: SpawnOptions) => ChildProcess;
}

/**
 * Answer one `/goal` command from a short-lived CLI, for when the session has no
 * resident one. `/goal` and `/goal clear` are handled inside the CLI: no model
 * call, no turn, no cost (measured). `--tools ""` empties the built-in tool set
 * (measured: `init.tools` is `[]`), so a future CLI that answered them with a
 * query still could not touch the tree. `--allowedTools ""` would NOT do this:
 * it is a permission allowlist, not the tool set.
 */
export async function runClaudeGoalControl(
  opts: ClaudeGoalControlOptions,
): Promise<AgentGoalCommandResult> {
  const text = goalCommandText(opts.command);
  const spawnProcess = opts.spawnProcess ?? ((args, spawnOpts) => spawn("claude", args, spawnOpts));
  const proc = spawnProcess([
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--tools", "",
    "--resume", opts.threadId,
  ], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<AgentGoalCommandResult>((resolve, reject) => {
      let buffer = "";
      let answered = false;
      const finish = (run: () => void): void => {
        if (answered) return;
        answered = true;
        run();
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        buffer += stripAnsi(chunk.toString("utf-8"));
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ClaudeEvent;
          try {
            event = JSON.parse(line) as ClaudeEvent;
          } catch {
            continue;
          }
          // The result carries the same text as the meta message and ends the run.
          if (event.type !== "result") continue;
          finish(() => {
            try {
              resolve({ goal: goalFromAnswer(parseGoalAnswer(event.result ?? "")) });
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        }
      });
      proc.stdin?.on("error", () => { /* surfaced by close */ });
      proc.on("error", (err) => { finish(() => { reject(err); }); });
      proc.on("close", (code) => {
        finish(() => {
          reject(new Error(`claude exited (${code ?? "signal"}) before answering the goal command`));
        });
      });

      timer = setTimeout(() => {
        finish(() => { reject(new Error("Claude Code did not answer the goal command in time")); });
      }, opts.timeoutMs ?? GOAL_CONTROL_TIMEOUT_MS);

      proc.stdin?.write(`${JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`);
      proc.stdin?.end();
    });
  } finally {
    clearTimeout(timer);
    killProcessTree(proc, "SIGTERM", { label: "claude-goal" });
  }
}
