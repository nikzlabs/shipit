import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ClaudeEvent, ImageAttachment, PermissionMode } from "../../../shared/types.js";
import { stripAnsi } from "../../../shared/strip-ansi.js";

/**
 * Phrases that signal an auth failure in CLI output. Used both for non-JSON
 * stderr lines (startup auth prompts) and for the text of an error `result`
 * event (a runtime 401). docs/142 A1 added the credential/401 phrasings: a
 * runtime "API Error: 401 Invalid authentication credentials" arrives as a
 * structured `result` event with `subtype: "error"`, NOT a stderr line, so it
 * previously slipped past detection and died as a generic error instead of
 * flipping the session into the OAuth/re-auth flow.
 */
const AUTH_ERROR_PATTERNS = [
  "not authenticated",
  "not logged in",
  "authentication required",
  "please login",
  "unauthorized",
  "oauth",
  "sign in",
  "invalid authentication credentials",
  "authentication_error",
  "invalid api key",
  "invalid x-api-key",
];

/** True when `text` contains any known auth-failure phrase (case-insensitive). */
export function textIndicatesAuthFailure(text: string): boolean {
  const lc = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lc.includes(p));
}

/**
 * True when a parsed event is an error `result` whose message indicates an auth
 * failure (the runtime-401 case). Other event types and successful results are
 * ignored.
 */
export function resultEventIndicatesAuthFailure(event: ClaudeEvent): boolean {
  if (event.type !== "result" || event.subtype !== "error") return false;
  return typeof event.result === "string" && textIndicatesAuthFailure(event.result);
}

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
    //
    // `mcp__shipit-review__*`, `mcp__shipit-present__*`, and
    // `mcp__shipit-voice__*` are allowlisted alongside playwright because these
    // bridges are built-in MCP servers the worker registers in mcp.json
    // (docs/125, docs/093, docs/163), not user-configured ones — so they never
    // flow through `mcpServerNames`. Without these entries the CLI gates the
    // bridge tools behind an interactive prompt that headless `-p` mode cannot
    // satisfy ("permission not yet granted", docs/149). All three write only to
    // ShipIt's own state (review drafts, present buffer, a voice note), so they
    // are safe under plan mode — and the voice tool is needed in plan mode so the
    // agent can author a headline before ExitPlanMode.
    const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__*,mcp__shipit-review__*,mcp__shipit-present__*,mcp__shipit-voice__*,mcp__shipit-bug__*";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit-review__*,mcp__shipit-present__*,mcp__shipit-voice__*,mcp__shipit-bug__*";

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
      // `--append-system-prompt` (not `--system-prompt`) so the CLI's default
      // system prompt is preserved — that gives us Anthropic's cross-user
      // prompt-cache benefits on the stable preamble, and lets
      // `--exclude-dynamic-system-prompt-sections` move per-machine sections
      // (cwd, git status, env, memory paths) out of the cached prefix and into
      // the first user message. `--exclude-dynamic-system-prompt-sections` is
      // a no-op with `--system-prompt`, which is why we don't use that flag.
      args.push("--append-system-prompt", effectiveSystemPrompt);
      args.push("--exclude-dynamic-system-prompt-sections");
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
        // docs/142 A1 — a runtime 401 arrives as an error `result` event, not a
        // stderr line; surface it as an auth failure so the session re-auths.
        if (resultEventIndicatesAuthFailure(event)) this.emit("auth_required");
        this.emit("event", event);
      } catch {
        // Not valid JSON — relay as log output.
        // With a PTY, auth-related messages also arrive here (merged stream).
        if (textIndicatesAuthFailure(trimmed)) {
          this.emit("auth_required");
        }
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}

/**
 * StreamingClaudeProcess — persistent Claude CLI process using
 * --input-format stream-json for live steering (docs/140).
 *
 * Unlike ClaudeProcess (PTY, one-shot per turn), this class:
 * - Spawns once and keeps the process alive across turns.
 * - Sends user messages as NDJSON on stdin.
 * - Treats `result` events as turn-end without killing the process.
 * - Emits `done` only when the process actually exits (on kill/dispose).
 * - Uses piped stdio (not PTY) since stream-json input is designed for pipes.
 */
export class StreamingClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private requestIdCounter = 0;

  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, settingsPath, autoCreatePr } = opts;

    // See ClaudeProcess.run above for why `mcp__shipit-review__*` and
    // `mcp__shipit-present__*` join `mcp__playwright__*` in both lists
    // (docs/125, docs/149).
    const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__*,mcp__shipit-review__*,mcp__shipit-present__*,mcp__shipit-voice__*,mcp__shipit-bug__*";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit-review__*,mcp__shipit-present__*,mcp__shipit-voice__*,mcp__shipit-bug__*";

    const userMcpGlobs = (mcpServerNames ?? []).map((name) => `mcp__${name}__*`).join(",");
    const withUserMcp = (base: string): string => userMcpGlobs ? `${base},${userMcpGlobs}` : base;
    const tools = permissionMode === "plan" ? PLAN_TOOLS : withUserMcp(AUTO_TOOLS);

    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--replay-user-messages",
      "--verbose",
      "--allowedTools", tools,
    ];

    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (permissionMode === "guarded") {
      args.push("--permission-mode", "auto");
    }

    if (sessionId) args.push("--resume", sessionId);
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    if (model) args.push("--model", model);
    if (settingsPath) args.push("--settings", settingsPath);
    if (systemPrompt) {
      // See the PTY-spawn branch above for why we use --append-system-prompt
      // and --exclude-dynamic-system-prompt-sections instead of --system-prompt.
      args.push("--append-system-prompt", systemPrompt);
      args.push("--exclude-dynamic-system-prompt-sections");
    }

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

    console.log("[streaming-claude] spawning:", "claude", args.slice(0, 8).join(" "), "| cwd:", cwd);

    try {
      this.proc = spawn("claude", args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.buffer = "";

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const trimmed = text.trim();
      if (!trimmed) return;
      this.checkAuthMessages(trimmed);
      console.warn("[streaming-claude] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    });

    this.proc.on("error", (err) => {
      this.clearWatchdog();
      this.emit("error", err);
    });

    this.proc.on("close", (exitCode) => {
      this.clearWatchdog();
      this.drainLines(true);
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // Send the initial user message
    this.sendUserMessage(prompt);
  }

  sendUserMessage(text: string, _opts?: { images?: ImageAttachment[] }): void {
    const msg = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    };
    const line = `${JSON.stringify(msg)}\n`;
    // docs/140 diag — log bytes written + a text snippet so a live-steering
    // bug repro shows whether the NDJSON line actually reached the CLI's
    // stdin. Paired with the `[claude-adapter]` log one frame up and the
    // worker-side `[steer-worker]` log one frame below.
    console.log(
      `[streaming-claude] sendUserMessage NDJSON bytes=${line.length} text=${JSON.stringify(text.slice(0, 80))}`,
    );
    this.writeToStdin(line);
    this.armWatchdog();
  }

  writeStdin(data: string): void {
    this.writeToStdin(data);
  }

  interrupt(): void {
    const requestId = `ctrl-${++this.requestIdCounter}-${Date.now()}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    };
    this.writeToStdin(`${JSON.stringify(msg)}\n`);

    // docs/140 — DO NOT force-kill the process on a streaming interrupt. Unlike
    // the PTY one-shot path (where Ctrl+C genuinely exits the CLI), a streaming
    // `control_request` interrupt is graceful by design: the CLI ends the
    // current turn with a `result` (subtype `error_during_execution`) and keeps
    // the persistent process alive for the next message. A 5s force-kill timer
    // here always fired — the process never closes, so the timer SIGTERMs the
    // still-alive process (exit 143), tearing down the persistent session and
    // any turn the user steered into it after interrupting. The watchdog (armed
    // on send, cleared on `result`) and idle eviction own teardown of a
    // genuinely stuck process; interrupt must not.
  }

  /**
   * Push a `set_permission_mode` control_request onto stdin so the persistent
   * CLI process changes mode mid-stream — no restart, same session_id. The
   * CLI replies with a control_response and emits a fresh `init` event
   * carrying the new mode (which the orchestrator's existing init listener
   * uses for guarded-availability detection). `mode` is the CLI's string
   * (`"plan"`, `"auto"`, `"default"`, …) — the adapter does the ShipIt → CLI
   * mapping.
   */
  setPermissionMode(cliMode: string): void {
    const requestId = `set-mode-${++this.requestIdCounter}-${Date.now()}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "set_permission_mode", mode: cliMode },
    };
    console.log(`[streaming-claude] setPermissionMode → ${cliMode}`);
    this.writeToStdin(`${JSON.stringify(msg)}\n`);
  }

  kill(): void {
    this.clearWatchdog();
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private writeToStdin(data: string): void {
    // docs/140 diag — surface the two ways a write to a "live" streaming
    // process can silently drop. Without these warnings the user sees the
    // optimistic message bubble in chat but the CLI never gets the line, and
    // the orchestrator has no record of why.
    if (!this.proc) {
      console.warn(
        `[streaming-claude] writeToStdin: no process — message DROPPED (bytes=${data.length})`,
      );
      this.emit(
        "log",
        "server",
        "Live steering write failed: the streaming process is not running. Message dropped.",
      );
      return;
    }
    if (!this.proc.stdin?.writable) {
      console.warn(
        `[streaming-claude] writeToStdin: stdin not writable (destroyed=${this.proc.stdin?.destroyed ?? "?"}, ended=${this.proc.stdin?.writableEnded ?? "?"}) — message DROPPED (bytes=${data.length})`,
      );
      this.emit(
        "log",
        "server",
        "Live steering write failed: stdin is not writable. Message dropped.",
      );
      return;
    }
    const ok = this.proc.stdin.write(data);
    if (!ok) {
      // Backpressure: write was buffered. Not an error, just noteworthy if a
      // steer never seems to land.
      console.warn(
        `[streaming-claude] writeToStdin: write returned false (backpressure, bytes=${data.length})`,
      );
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      console.warn("[streaming-claude] No output within 30s — process may be stuck");
      this.emit("log", "server", "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private checkAuthMessages(text: string): void {
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
  }

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
        const event = JSON.parse(trimmed) as ClaudeEvent;
        // Clear watchdog on any valid event (turn is making progress)
        if (event.type === "result") {
          // Turn ended — arm watchdog for next potential turn; don't kill process
          this.clearWatchdog();
        }
        // docs/142 A1 — a runtime 401 comes through as an error `result` event;
        // surface it as an auth failure so the session re-auths instead of the
        // turn dying as a generic error.
        if (resultEventIndicatesAuthFailure(event)) this.emit("auth_required");
        this.emit("event", event);
      } catch {
        if (textIndicatesAuthFailure(trimmed)) {
          this.emit("auth_required");
        }
        console.warn("[streaming-claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
