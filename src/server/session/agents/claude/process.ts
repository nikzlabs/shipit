import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import type { ClaudeEvent, ImageAttachment, PermissionMode, ServiceRouting } from "../../../shared/types.js";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import type { AgentHomeResolver } from "../../../shared/agent-home.js";
import { resolveAgentHome } from "../../../shared/agent-home.js";

// Environment credentials override disk login; unscoped routes still need them.
function scrubEnvAuthForScopedHome(env: Record<string, string>, scopedHome: string | undefined): void {
  if (!scopedHome) return;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
}

import { applyServiceRouting, claudeModelArg } from "../../../shared/spawn-routing.js";
export { applyServiceRouting };

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
  "authentication_failed",
  "invalid api key",
  "invalid x-api-key",
];

export function textIndicatesAuthFailure(text: string): boolean {
  const lc = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lc.includes(p));
}

// API errors can have subtype "success" and is_error: true (CLI 2.1.219).
export function resultEventIsError(event: ClaudeEvent): boolean {
  if (event.type !== "result") return false;
  return event.is_error === true || event.subtype !== "success";
}

export function resultEventIndicatesAuthFailure(event: ClaudeEvent): boolean {
  if (!resultEventIsError(event) || event.type !== "result") return false;

  // Other failures can carry model prose. Older CLIs omit terminal_reason.
  if (event.subtype === "error_max_turns" || event.subtype === "error_during_execution") return false;
  if (typeof event.terminal_reason === "string" && event.terminal_reason !== "api_error") return false;

  return typeof event.result === "string" && textIndicatesAuthFailure(event.result);
}

// Require the synthetic error flag so model prose cannot trigger auth recovery.
export function assistantEventIndicatesAuthFailure(event: ClaudeEvent): boolean {
  if (event.type !== "assistant" || event.is_api_error_message !== true) return false;
  if (typeof event.error === "string" && textIndicatesAuthFailure(event.error)) return true;
  return event.message.content.some(
    (block) => block.type === "text" && textIndicatesAuthFailure(block.text),
  );
}

// Swallow both auth frames; the caller raises once per turn to prevent duplicate retries.
function consumeAuthFailureEvent(event: ClaudeEvent, raiseAuthRequiredOnce: () => void): boolean {
  if (!assistantEventIndicatesAuthFailure(event) && !resultEventIndicatesAuthFailure(event)) {
    return false;
  }
  raiseAuthRequiredOnce();
  return true;
}

export interface ClaudeRunOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd?: string;
  permissionMode?: PermissionMode;
  mcpConfigPath?: string;
  mcpServerNames?: string[];
  model?: string;
  serviceRouting?: ServiceRouting;
  homeDir?: string;
  reasoningEffort?: string;
  settingsPath?: string;
  autoCreatePr?: boolean;
  sandbox?: boolean;
  guardDestructiveGit?: boolean;
  permissionPromptTool?: string;
}

// Files avoid Linux's 128 KiB limit per argument. The caller deletes the file.
function writeSystemPromptFile(text: string): string {
  // Concurrent spawns must not share a file.
  const path = `/tmp/claude-system-prompt-${randomUUID()}.txt`;
  fs.writeFileSync(path, text, "utf-8");
  return path;
}

function removeFileQuietly(path: string | null): void {
  if (!path) return;
  try { fs.unlinkSync(path); } catch { /* already gone */ }
}

function frameUserMessage(text: string): string {
  const msg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(msg)}\n`;
}

// Routed providers can report per-call token usage only in message_delta.
const PARTIAL_MESSAGE_ARGS = ["--include-partial-messages"] as const;

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private systemPromptFile: string | null = null;
  private stdinFailure: Error | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private authRaisedThisTurn = false;

  constructor(private readonly resolveHome?: AgentHomeResolver) {
    super();
  }

  private raiseAuthRequiredOnce(): void {
    if (this.authRaisedThisTurn) return;
    this.authRaisedThisTurn = true;
    this.emit("auth_required");
  }

  // Stdin avoids the per-argument size limit; EOF makes this process one-shot.
  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, reasoningEffort, settingsPath, autoCreatePr, sandbox, guardDestructiveGit, permissionPromptTool, serviceRouting, homeDir } = opts;
    this.authRaisedThisTurn = false;

    // Exact ShipIt names exclude permission_prompt. ExitPlanMode needs headless approval.
    // Explicit skills can write even in plan mode.
    const AUTO_TOOLS = "Write,Read,Edit,NotebookEdit,Bash,PowerShell,Monitor,Glob,Grep,LSP,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,ShareOnboardingGuide,Workflow,mcp__playwright__*,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";

    // Third-party MCP tools cannot be assumed read-only in plan mode.
    const userMcpGlobs = (mcpServerNames ?? [])
      .map((name) => `mcp__${name}__*`)
      .join(",");
    const withUserMcp = (base: string): string =>
      userMcpGlobs ? `${base},${userMcpGlobs}` : base;

    const tools = permissionMode === "plan"
      ? PLAN_TOOLS
      : withUserMcp(AUTO_TOOLS);

    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools,
    ];

    // CLI auto applies the classifier even with the Bash allowlist entry.
    if (permissionMode === "plan") {
      args.push("--permission-mode", "plan");
    } else if (permissionMode === "guarded") {
      args.push("--permission-mode", "auto");
    }

    if (serviceRouting) {
      args.push(...PARTIAL_MESSAGE_ARGS);
    }

    if (sessionId) {
      args.push("--resume", sessionId);
    }

    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    if (permissionPromptTool) {
      args.push("--permission-prompt-tool", permissionPromptTool);
    }

    if (model) {
      args.push("--model", claudeModelArg(model));
    }

    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }

    if (settingsPath) {
      args.push("--settings", settingsPath);
    }

    const effectiveSystemPrompt = systemPrompt;

    if (effectiveSystemPrompt) {
      // Append preserves the cached CLI preamble; exclusion is a no-op with replacement.
      this.systemPromptFile = writeSystemPromptFile(effectiveSystemPrompt);
      args.push("--append-system-prompt-file", this.systemPromptFile);
      args.push("--exclude-dynamic-system-prompt-sections");
    }

    console.log(
      "[claude] spawning:", "claude", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(prompt)} | cwd:`, cwd,
    );

    const scopedHome = homeDir ?? this.resolveHome?.();
    const spawnEnv: Record<string, string> = {
      ...process.env,
      HOME: resolveAgentHome(scopedHome),
      NODE_ENV: "development",
    };
    scrubEnvAuthForScopedHome(spawnEnv, scopedHome);
    // Apply routing after the scrub, which deletes these credentials.
    const shaped = applyServiceRouting(spawnEnv, serviceRouting);
    if (serviceRouting) {
      console.log(
        `[claude] service routing: ${serviceRouting.serviceId}/${serviceRouting.billingMode}`
        + ` -> ${serviceRouting.baseUrl}`,
      );
      if (!shaped.credentialDelivered) {
        console.warn(
          `[claude] no credential in the environment for ${serviceRouting.serviceId}`
          + `/${serviceRouting.billingMode} (expected ${serviceRouting.credentialSourceEnv})`,
        );
        this.raiseAuthRequiredOnce();
        return;
      }
    }
    if (autoCreatePr) {
      spawnEnv.SHIPIT_AUTO_CREATE_PR = "1";
    } else {
      delete spawnEnv.SHIPIT_AUTO_CREATE_PR;
    }
    if (sandbox) {
      spawnEnv.SHIPIT_SANDBOX = "1";
    } else {
      delete spawnEnv.SHIPIT_SANDBOX;
    }
    if (guardDestructiveGit) {
      spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT = "1";
    } else {
      delete spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT;
    }

    try {
      this.proc = spawn("claude", args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.stdinFailure = null;

    this.watchdog = setTimeout(() => {
      console.warn("[claude] No output received within 30 seconds — process may be stuck");
      this.emit("log", "server", "Warning: No output from Claude CLI after 30 seconds. The process may be stuck.");
      this.watchdog = null;
    }, 30_000);

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.buffer += stripAnsi(chunk.toString("utf-8"));
      this.drainLines();
    });

    // Buffer lines: an auth phrase can span pipe chunks.
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.clearWatchdog();
      this.stderrBuffer += stripAnsi(chunk.toString("utf-8"));
      this.drainStderrLines();
    });

    this.proc.on("error", (err) => {
      this.clearWatchdog();
      this.emit("error", err);
    });

    // Mid-write EPIPE reaches stdin, not the child's error handler.
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      this.clearWatchdog();
      console.warn(`[claude] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
      // Wait for stderr to drain so EPIPE cannot hide an auth failure.
      this.stdinFailure = err;
    });

    this.proc.on("close", (exitCode) => {
      this.clearWatchdog();
      this.drainLines(true);
      this.drainStderrLines(true);
      if (this.stdinFailure && !this.authRaisedThisTurn) {
        this.emit("error", this.stdinFailure);
      }
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    this.writeStdin(frameUserMessage(prompt));
    this.proc.stdin?.end();
  }

  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (textIndicatesAuthFailure(trimmed)) {
        this.raiseAuthRequiredOnce();
      }
      console.warn("[claude] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  writeStdin(data: string): void {
    if (!this.proc?.stdin?.writable) {
      console.warn(`[claude] writeStdin: stdin not writable — ${data.length} bytes dropped`);
      return;
    }
    this.proc.stdin.write(data);
  }

  // Stdin is closed. Signal the CLI first so it can flush before tree-wide teardown.
  interrupt(): void {
    if (!this.proc) return;

    killChild(this.proc, "SIGINT");

    const forceKillTimer = setTimeout(() => {
      if (this.proc) {
        console.warn("[claude] Force killing process after interrupt timeout");
        this.kill();
      }
    }, 5000);

    this.proc.once("close", () => {
      clearTimeout(forceKillTimer);
    });
  }

  kill(): void {
    this.clearWatchdog();
    if (this.proc) {
      killProcessTree(this.proc, "SIGTERM", { label: "claude" });
      this.proc = null;
    }
    removeFileQuietly(this.systemPromptFile);
    this.systemPromptFile = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
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
        if (consumeAuthFailureEvent(event, () => this.raiseAuthRequiredOnce())) continue;
        this.emit("event", event);
      } catch {
        if (textIndicatesAuthFailure(trimmed)) {
          this.raiseAuthRequiredOnce();
        }
        console.warn("[claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}

// Open stdin keeps the CLI alive across turns; result ends a turn, done ends the process.
export class StreamingClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private systemPromptFile: string | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private requestIdCounter = 0;

  constructor(private readonly resolveHome?: AgentHomeResolver) {
    super();
  }
  private authRaisedThisTurn = false;

  private raiseAuthRequiredOnce(): void {
    if (this.authRaisedThisTurn) return;
    this.authRaisedThisTurn = true;
    this.emit("auth_required");
  }

  run(opts: ClaudeRunOptions): void {
    const { prompt, sessionId, systemPrompt, cwd, permissionMode, mcpConfigPath, mcpServerNames, model, reasoningEffort, settingsPath, autoCreatePr, sandbox, guardDestructiveGit, permissionPromptTool, serviceRouting, homeDir } = opts;

    const AUTO_TOOLS = "Write,Read,Edit,NotebookEdit,Bash,PowerShell,Monitor,Glob,Grep,LSP,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,ShareOnboardingGuide,Workflow,mcp__playwright__*,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";
    const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,ExitPlanMode,Skill,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__shipit__present,mcp__shipit__voice_note,mcp__shipit__report_shipit_bug,mcp__shipit__propose_actions";

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

    if (serviceRouting) args.push(...PARTIAL_MESSAGE_ARGS);
    if (sessionId) args.push("--resume", sessionId);
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    if (permissionPromptTool) args.push("--permission-prompt-tool", permissionPromptTool);
    if (model) args.push("--model", claudeModelArg(model));
    if (reasoningEffort) args.push("--effort", reasoningEffort);
    if (settingsPath) args.push("--settings", settingsPath);
    if (systemPrompt) {
      this.systemPromptFile = writeSystemPromptFile(systemPrompt);
      args.push("--append-system-prompt-file", this.systemPromptFile);
      args.push("--exclude-dynamic-system-prompt-sections");
    }

    const scopedHome = homeDir ?? this.resolveHome?.();
    const spawnEnv: Record<string, string> = {
      ...process.env,
      HOME: resolveAgentHome(scopedHome),
      NODE_ENV: "development",
    };
    scrubEnvAuthForScopedHome(spawnEnv, scopedHome);
    const shaped = applyServiceRouting(spawnEnv, serviceRouting);
    if (serviceRouting) {
      console.log(
        `[claude] service routing: ${serviceRouting.serviceId}/${serviceRouting.billingMode}`
        + ` -> ${serviceRouting.baseUrl}`,
      );
      if (!shaped.credentialDelivered) {
        console.warn(
          `[claude] no credential in the environment for ${serviceRouting.serviceId}`
          + `/${serviceRouting.billingMode} (expected ${serviceRouting.credentialSourceEnv})`,
        );
        this.raiseAuthRequiredOnce();
        return;
      }
    }
    if (autoCreatePr) {
      spawnEnv.SHIPIT_AUTO_CREATE_PR = "1";
    } else {
      delete spawnEnv.SHIPIT_AUTO_CREATE_PR;
    }
    if (sandbox) {
      spawnEnv.SHIPIT_SANDBOX = "1";
    } else {
      delete spawnEnv.SHIPIT_SANDBOX;
    }
    // System turns use a fresh process, so self-merge wakes get the updated guard.
    if (guardDestructiveGit) {
      spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT = "1";
    } else {
      delete spawnEnv.SHIPIT_GUARD_DESTRUCTIVE_GIT;
    }

    console.log("[streaming-claude] spawning:", "claude", args.slice(0, 8).join(" "), "| cwd:", cwd);

    try {
      this.proc = spawn("claude", args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
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

    // Log dropped writes without ending the resident session.
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      console.warn(`[streaming-claude] stdin error (${err.code ?? "unknown"}) — message DROPPED`);
      this.emit("log", "server", `Write to the Claude CLI failed (${err.code ?? "unknown"}). The message was not delivered.`);
    });

    this.proc.on("close", (exitCode) => {
      this.clearWatchdog();
      this.drainLines(true);
      removeFileQuietly(this.systemPromptFile);
      this.systemPromptFile = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    this.sendUserMessage(prompt);
  }

  sendUserMessage(text: string, _opts?: { images?: ImageAttachment[] }): void {
    this.authRaisedThisTurn = false;
    const line = frameUserMessage(text);
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

    // Interrupt ends the turn, not the process. A force-kill timer would kill later turns.
  }

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
      killProcessTree(this.proc, "SIGTERM", { label: "streaming-claude" });
      this.proc = null;
    }
    removeFileQuietly(this.systemPromptFile);
    this.systemPromptFile = null;
  }

  private writeToStdin(data: string): void {
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
      this.raiseAuthRequiredOnce();
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
        if (event.type === "result") {
          this.clearWatchdog();
        }
        if (consumeAuthFailureEvent(event, () => this.raiseAuthRequiredOnce())) continue;
        this.emit("event", event);
      } catch {
        if (textIndicatesAuthFailure(trimmed)) {
          this.raiseAuthRequiredOnce();
        }
        console.warn("[streaming-claude] non-JSON line:", trimmed.slice(0, 120));
        this.emit("log", "stdout", trimmed);
      }
    }
  }
}
