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
      // Log stderr for debugging but don't relay to client
      const text = chunk.toString().trim();
      if (text) console.error("[claude stderr]", text);
    });

    this.proc.on("close", (code) => {
      // Drain any remaining buffer
      this.drainLines();
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

  private drainLines(): void {
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) chunk in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event: ClaudeEvent = JSON.parse(trimmed);
        this.emit("event", event);
      } catch {
        // Not valid JSON — skip
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
      }
    }
  }
}
