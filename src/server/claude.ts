import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ClaudeEvent } from "./types.js";

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";

  /**
   * Send a prompt to Claude CLI in print mode with streaming JSON output.
   * Emits "event" for each parsed NDJSON line and "done" when the process exits.
   */
  run(prompt: string, sessionId?: string): void {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch",
    ];

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    this.proc = spawn("claude", args, {
      cwd: "/workspace",
      env: { ...process.env, HOME: "/root" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.buffer = "";

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.drainLines();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      console.error("[claude stderr]", text);
      this.emit("log", "stderr", text);

      // Detect auth-related errors — CLI exits with auth messages when not logged in
      const lc = text.toLowerCase();
      if (
        lc.includes("not authenticated") ||
        lc.includes("not logged in") ||
        lc.includes("authentication required") ||
        lc.includes("please login") ||
        lc.includes("unauthorized") ||
        lc.includes("oauth") ||
        lc.includes("sign in")
      ) {
        this.emit("auth_required");
      }
    });

    this.proc.on("close", (code) => {
      // Drain any remaining buffer, flushing the final (possibly unterminated) line
      this.drainLines(true);
      this.emit("done", code);
      this.proc = null;
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
      this.proc = null;
    });
  }

  /** Kill the running process if any. */
  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  /**
   * Parse complete NDJSON lines from the buffer.
   * @param flush - If true, also attempt to parse the final unterminated segment
   *   (used on process close to avoid losing the last event).
   */
  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) chunk unless flushing
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event: ClaudeEvent = JSON.parse(trimmed);
        this.emit("event", event);
      } catch {
        // Not valid JSON — relay as stdout log
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
