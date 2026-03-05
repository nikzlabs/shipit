import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import type { ClaudeEvent, ImageAttachment, PermissionMode } from "../shared/types.js";
import { stripAnsi } from "../shared/strip-ansi.js";

export class ClaudeProcess extends EventEmitter {
  private proc: IPty | null = null;
  private buffer = "";
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  /**
   * Send a prompt to Claude CLI in print mode with streaming JSON output.
   * Emits "event" for each parsed NDJSON line and "done" when the process exits.
   *
   * Uses node-pty to allocate a real PTY so the CLI behaves as if invoked
   * from an interactive terminal (avoids hangs caused by piped stdin).
   *
   * When `images` is provided, the prompt is sent via stdin as a JSON content
   * array containing image blocks followed by a text block.
   */
  run(prompt: string, sessionId?: string, systemPrompt?: string, images?: ImageAttachment[], cwd?: string, permissionMode?: PermissionMode): void {
    const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch";
    const NORMAL_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion";

    const tools = permissionMode === "plan"
      ? PLAN_TOOLS
      : permissionMode === "normal"
        ? NORMAL_TOOLS
        : AUTO_TOOLS;

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools,
    ];

    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    // Build effective system prompt, injecting normal-mode instructions if needed
    let effectiveSystemPrompt = systemPrompt;
    if (permissionMode === "normal") {
      const normalInstruction = `IMPORTANT: You are in supervised mode. Before making ANY file changes or running commands:\n1. Describe what you plan to do\n2. Use AskUserQuestion to get approval first\n3. Only proceed after the user approves\nNever skip the approval step.`;
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${normalInstruction}\n\n${effectiveSystemPrompt}`
        : normalInstruction;
    }

    if (effectiveSystemPrompt) {
      args.push("--system-prompt", effectiveSystemPrompt);
    }

    const spawnCwd = cwd ?? "/workspace";
    console.log("[claude] spawning:", "claude", args.join(" ").slice(0, 200), "| cwd:", spawnCwd);

    try {
      this.proc = pty.spawn("claude", args, {
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

    // When images are provided, write them to stdin as base64 content blocks.
    // The CLI will pick up multimodal content from the piped input.
    if (images && images.length > 0) {
      const content = [
        ...images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
        })),
        { type: "text" as const, text: prompt },
      ];
      const payload = JSON.stringify(content);
      this.proc.write(`${payload  }\n`);
    }

    // Inactivity watchdog: warn if no output within 30 seconds
    this.watchdog = setTimeout(() => {
      console.warn("[claude] No output received within 30 seconds — process may be stuck");
      this.emit("log", "server", "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);

    // PTY combines stdout and stderr into a single data stream.
    // Strip ANSI codes, then use drainLines() to separate JSON events from log text.
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
      // Drain any remaining buffer, flushing the final (possibly unterminated) line
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

  /** Send Ctrl+C to the running process, with a force-kill fallback after 5s. */
  interrupt(): void {
    if (!this.proc) return;

    // Send Ctrl+C (ETX) character to the PTY
    this.proc.write("\x03");

    // If the process doesn't exit within 5 seconds, force kill
    const forceKillTimer = setTimeout(() => {
      if (this.proc) {
        console.warn("[claude] Force killing process after interrupt timeout");
        this.kill();
      }
    }, 5000);

    // Clear the force-kill timer when the process exits normally
    this.proc.onExit(() => {
      clearTimeout(forceKillTimer);
    });
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
        const event = JSON.parse(trimmed) as ClaudeEvent;
        this.emit("event", event);
      } catch {
        // Not valid JSON — relay as log output.
        // With a PTY, auth-related messages also arrive here (merged stream).
        const lc = trimmed.toLowerCase();
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
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
