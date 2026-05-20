import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import type { ClaudeEvent, ImageAttachment, PermissionMode } from "../shared/types.js";
import { stripAnsi } from "../shared/strip-ansi.js";

export interface ClaudeRunOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd?: string;
  permissionMode?: PermissionMode;
  /** Path to an MCP config JSON file passed via --mcp-config. */
  mcpConfigPath?: string;
  /**
   * Names of enabled user MCP servers (docs/088). Each contributes a
   * `mcp__<name>__*` glob to the `auto` tool allowlist.
   * Deliberately excluded from `plan` mode — third-party MCP tools cannot be
   * assumed read-only.
   */
  mcpServerNames?: string[];
  /** Model alias or ID to use (e.g., "sonnet", "opus"). */
  model?: string;
  /**
   * Path to a Claude Code settings file (passed as `--settings`). The
   * orchestrator always points this at /etc/shipit/managed-settings.json for
   * the `claude` agent so the PreToolUse branch-block hook is active. See
   * docs/130-block-branch-ops/plan.md.
   */
  settingsPath?: string;
  /**
   * When true, set SHIPIT_AUTO_CREATE_PR=1 in the CLI environment. The
   * managed-settings.json Stop hook self-gates on this var to enforce PR
   * creation. See docs/129-stop-hook-pr-enforcement/plan.md.
   */
  autoCreatePr?: boolean;
}

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
   * Images are handled by the orchestrator before reaching this method —
   * they're saved to the host uploads directory and referenced in the prompt.
   */
  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, settingsPath, autoCreatePr } = opts;

    // `Skill` is allowlisted in both modes — including plan — so an explicit
    // `/my-skill` invocation is honored in every permission mode. This accepts
    // that plan mode is no longer guaranteed read-only when a user
    // deliberately invokes a side-effecting skill. See docs/138.
    const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__*";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot";

    // docs/088: enabled user MCP servers contribute a `mcp__<name>__*` glob to
    // the `auto` allowlist. `plan` mode deliberately omits them
    // — third-party MCP tools can't be assumed read-only.
    const userMcpGlobs = (mcpServerNames ?? [])
      .map((name) => `mcp__${name}__*`)
      .join(",");
    const withUserMcp = (base: string): string =>
      userMcpGlobs ? `${base},${userMcpGlobs}` : base;

    // `guarded` (docs/138) reuses the AUTO_TOOLS allowlist: the CLI's auto
    // (classifier) mode drops the blanket `Bash` grant and routes shell/network
    // through the classifier, while working-dir Write/Edit stay tier-2
    // auto-approved. Spike-confirmed the allowlist does not suppress the
    // classifier, so reusing AUTO_TOOLS is correct.
    const tools = permissionMode === "plan"
      ? PLAN_TOOLS
      : withUserMcp(AUTO_TOOLS);

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools,
    ];

    // Deliberate inversion (docs/138): ShipIt `guarded` → CLI `auto` (the
    // classifier-gated mode); ShipIt `auto` passes no flag. `plan` is verbatim.
    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (permissionMode === "guarded") {
      args.push("--permission-mode", "auto");
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    if (model) {
      args.push("--model", model);
    }

    if (settingsPath) {
      args.push("--settings", settingsPath);
    }

    const effectiveSystemPrompt = systemPrompt;

    if (effectiveSystemPrompt) {
      args.push("--system-prompt", effectiveSystemPrompt);
    }

    console.log("[claude] spawning:", "claude", args.join(" ").slice(0, 200), "| cwd:", cwd);

    // Build the spawn env. We start from `process.env` (so the CLI inherits
    // PATH, NODE-related vars, etc.) but explicitly normalize the
    // `SHIPIT_AUTO_CREATE_PR` gate: the managed-settings.json Stop hook
    // self-gates on it (docs/130), so if it leaks in from the parent process
    // (e.g. when this orchestrator is itself dogfooded under an outer ShipIt
    // that has the var set) the hook would activate even when `autoCreatePr`
    // is false. Always overwrite with the value derived from this call.
    const spawnEnv: Record<string, string> = {
      ...process.env,
      HOME: "/root",
      NODE_ENV: "development",
    } as Record<string, string>;
    if (autoCreatePr) {
      spawnEnv.SHIPIT_AUTO_CREATE_PR = "1";
    } else {
      delete spawnEnv.SHIPIT_AUTO_CREATE_PR;
    }

    try {
      this.proc = pty.spawn("claude", args, {
        name: "xterm-256color",
        cols: 200,
        rows: 24,
        cwd,
        env: spawnEnv,
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";

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
