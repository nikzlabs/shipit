/**
 * CodexProcess — spawns the OpenAI Codex CLI and parses its JSONL output.
 *
 * Codex CLI (`codex exec --json`) streams newline-delimited JSON events to
 * stdout. Each line has a `type` field indicating the event kind:
 *
 *   thread.started   — { type, thread_id }
 *   turn.started     — { type }
 *   turn.completed   — { type, usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   turn.failed      — { type, error: { message } }
 *   item.started     — { type, item: { id, type, ... } }
 *   item.updated     — { type, item: { id, type, ... } }
 *   item.completed   — { type, item: { id, type, ... } }
 *   error            — { type, message }
 *
 * Item types: agent_message, command_execution, file_change, mcp_tool_call,
 *             web_search, reasoning, todo_list, error.
 *
 * This class mirrors ClaudeProcess: spawns a PTY, buffers NDJSON, and emits
 * typed events that the CodexAdapter translates into AgentEvent.
 */

import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { stripAnsi } from "../auth.js";

// ---- Codex CLI event types ----

export interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

export interface CodexTurnStarted {
  type: "turn.started";
}

export interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

export interface CodexTurnFailed {
  type: "turn.failed";
  error?: { message?: string };
}

export interface CodexItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item: CodexItem;
}

export interface CodexItem {
  id: string;
  type: "agent_message" | "command_execution" | "file_change" | "mcp_tool_call" | "web_search" | "reasoning" | "todo_list" | "error";
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: "in_progress" | "completed" | "failed";
  changes?: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  server?: string;
  tool?: string;
}

export interface CodexErrorEvent {
  type: "error";
  message: string;
}

export type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemEvent
  | CodexErrorEvent;

// ---- CodexProcess ----

export class CodexProcess extends EventEmitter {
  private proc: IPty | null = null;
  private buffer = "";
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  /**
   * Spawn the Codex CLI in non-interactive (exec) mode with JSONL output.
   *
   * Uses `codex exec --json` which streams events to stdout and prints
   * progress to stderr.
   */
  run(
    prompt: string,
    approvalMode?: "suggest" | "auto-edit" | "full-auto",
    model?: string,
    cwd?: string,
  ): void {
    const args = ["exec", "--json"];

    if (approvalMode) {
      args.push(`--${approvalMode}`);
    } else {
      // Default to full-auto for ShipIt (matches Claude's auto mode)
      args.push("--full-auto");
    }

    if (model) {
      args.push("--model", model);
    }

    // The prompt goes last
    args.push(prompt);

    const spawnCwd = cwd ?? "/workspace";
    console.log("[codex] spawning:", "codex", args.join(" ").slice(0, 200), "| cwd:", spawnCwd);

    try {
      this.proc = pty.spawn("codex", args, {
        name: "xterm-256color",
        cols: 200,
        rows: 24,
        cwd: spawnCwd,
        env: { ...process.env, HOME: "/root" } as Record<string, string>,
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";

    // Inactivity watchdog: warn if no output within 30 seconds
    this.watchdog = setTimeout(() => {
      console.warn("[codex] No output received within 30 seconds — process may be stuck");
      this.emit("log", "server", "Warning: No output from Codex CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);

    this.proc.onData((data: string) => {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }

      const cleaned = stripAnsi(data);
      this.buffer += cleaned;
      this.drainLines();
    });

    this.proc.onExit(({ exitCode }) => {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
      this.drainLines(true);
      this.emit("done", exitCode);
      this.proc = null;
    });
  }

  /** Write data to the running process's stdin. */
  writeStdin(data: string): void {
    if (this.proc) {
      this.proc.write(data);
    }
  }

  /** Kill the running process if any. */
  kill(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  /**
   * Parse complete JSONL lines from the buffer.
   * @param flush - If true, also parse the final unterminated segment.
   */
  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as CodexEvent;
        this.emit("event", event);
      } catch {
        // Not valid JSON — relay as log output.
        const lc = trimmed.toLowerCase();
        if (
          lc.includes("api key") ||
          lc.includes("unauthorized") ||
          lc.includes("authentication") ||
          lc.includes("openai_api_key") ||
          lc.includes("not authenticated") ||
          lc.includes("invalid api key")
        ) {
          this.emit("auth_required");
        }
        console.warn("[codex] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
