/**
 * ClaudeAdapter — wraps ClaudeProcess (one-shot) or StreamingClaudeProcess
 * (persistent, streaming) to implement the AgentProcess interface.
 *
 * When params.useStreaming is true (live steering enabled), run() creates a
 * StreamingClaudeProcess that keeps the process alive across turns. Otherwise
 * it creates the legacy PTY ClaudeProcess. (docs/140)
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ClaudeProcess, StreamingClaudeProcess } from "./process.js";
import type { ClaudeEvent, ClaudeMcpServerInit, PermissionMode } from "../../../shared/types.js";
import { CLAUDE_PERMISSION_MODES } from "../../../shared/types.js";
import { CLAUDE_MODELS } from "../../../shared/agent-registry.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "../agent-process.js";
import type { McpServerStatus } from "../../../shared/types/mcp-types.js";
import type { SubscriptionLimitsWindow } from "../../../shared/types/usage-limits-types.js";
import { resolveMcpServer } from "../../mcp-resolve.js";

export class ClaudeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "claude";

  /**
   * Latest five_hour / seven_day windows accumulated from the CLI's
   * stream-json `rate_limit_event` messages. The CLI emits ONE window per
   * event (carrying `rateLimitType`), so we accumulate both locally and
   * emit a combined `agent_rate_limits` AgentEvent whenever either changes
   * — same shape Codex emits, single contract on the orchestrator side.
   * Anthropic-side: this data comes from `anthropic-ratelimit-unified-*`
   * response headers, so it's effectively free and bypasses the broken
   * `/api/oauth/usage` polling endpoint.
   */
  private rateLimitSession: SubscriptionLimitsWindow | null = null;
  private rateLimitWeekly: SubscriptionLimitsWindow | null = null;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: CLAUDE_PERMISSION_MODES,
    toolNames: [
      "Write", "Read", "Edit", "Bash", "Glob", "Grep",
      "WebFetch", "WebSearch", "AskUserQuestion",
    ],
    models: CLAUDE_MODELS,
    // Claude Code has both a subagent primitive (the Task tool) and custom
    // MCP tool registration via mcpConfigPath, which 125 needs.
    supportsReview: true,
    supportsSteering: true,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  private inner: ClaudeProcess | StreamingClaudeProcess;
  private _isStreaming = false;

  constructor(inner?: ClaudeProcess) {
    super();
    this.inner = inner ?? new ClaudeProcess();
    this.wireEvents(this.inner);
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /** Forward and translate events from the inner process. */
  private wireEvents(proc: ClaudeProcess | StreamingClaudeProcess): void {
    proc.on("event", (raw: ClaudeEvent) => {
      // docs/088: surface MCP connection status from init event
      if (raw.type === "system" && raw.subtype === "init" && raw.mcp_servers) {
        const statuses = raw.mcp_servers.map(mapCliMcpStatus);
        if (statuses.length > 0) {
          this.emit("mcp_status", statuses);
        }
      }

      const mapped = this.mapEvent(raw);
      if (mapped) {
        this.emit("event", mapped);
      }
    });

    proc.on("done", (code: number) => {
      this.emit("done", code);
    });

    proc.on("error", (err: Error) => {
      this.emit("error", err);
    });

    proc.on("auth_required", () => {
      this.emit("auth_required");
    });

    proc.on("log", (source: string, text: string) => {
      this.emit("log", source, text);
    });
  }

  /** Convert a raw ClaudeEvent into the normalized AgentEvent schema. */
  private mapEvent(raw: ClaudeEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        return {
          type: "agent_init",
          agentId: "claude",
          sessionId: raw.session_id,
          model: raw.model,
          tools: raw.tools,
          // docs/138 — authoritative guarded-mode availability signal.
          permissionMode: raw.permissionMode,
        };

      case "assistant":
        return {
          type: "agent_assistant",
          content: raw.message.content,
          // Preserve parent_tool_use_id from nested subagent events so the
          // client can render the subagent's work under its parent Task tool
          // (109 — subagent transparency).
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "user":
        // Skip replayed user messages (--replay-user-messages echo) to avoid
        // double-rendering — the orchestrator already emitted message_steered.
        if (raw.isReplay) return null;
        return {
          type: "agent_tool_result",
          content: raw.message.content,
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "result": {
        const u = raw.usage;
        // Real per-turn context occupancy = the LAST iteration's input +
        // cache_read + cache_create. The top-level `usage.*_input_tokens`
        // values are sums across every API call in the turn, so using them
        // directly multiplies context size by the iteration count.
        let contextTokens: number | undefined;
        const lastIter = u?.iterations?.length
          ? u.iterations[u.iterations.length - 1]
          : undefined;
        if (lastIter) {
          contextTokens =
            (lastIter.input_tokens ?? 0) +
            (lastIter.cache_read_input_tokens ?? 0) +
            (lastIter.cache_creation_input_tokens ?? 0);
        }
        // Authoritative context window comes from `modelUsage.<model>.contextWindow`
        // (e.g. Opus 4.7 reports 1_000_000). Falls back to the static map on
        // the receiving end when undefined.
        const modelUsage = raw.modelUsage;
        let contextWindow: number | undefined;
        if (modelUsage) {
          // Prefer the largest reported window across models touched in the
          // turn (handles model switches mid-turn — keep the more permissive).
          for (const m of Object.values(modelUsage)) {
            if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
              contextWindow = m.contextWindow;
            }
          }
        }
        return {
          type: "agent_result",
          status: raw.subtype,
          sessionId: raw.session_id,
          cost: raw.total_cost_usd !== null && raw.total_cost_usd !== undefined
            ? { totalUsd: raw.total_cost_usd }
            : undefined,
          tokens: u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
            ? {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
              }
            : undefined,
          contextTokens,
          contextWindow,
          durationMs: raw.duration_ms,
          error: raw.subtype === "error" ? raw.result : undefined,
          // docs/138 — normalize the CLI's snake_case classifier denials into
          // the camelCase shape the orchestrator consumes for inline surfacing.
          permissionDenials: raw.permission_denials?.length
            ? raw.permission_denials.map((d) => ({
                toolName: d.tool_name,
                toolUseId: d.tool_use_id,
                toolInput: d.tool_input,
              }))
            : undefined,
        };
      }

      case "rate_limit_event": {
        const info = raw.rate_limit_info;
        const type = info?.rateLimitType;
        // We only track the headline windows. seven_day_opus / seven_day_sonnet
        // / overage carry sub-quotas the badge UI doesn't render.
        if (type !== "five_hour" && type !== "seven_day") return null;
        const window = parseRateLimitWindow(info);
        if (!window) return null;
        if (type === "five_hour") {
          this.rateLimitSession = window;
        } else {
          this.rateLimitWeekly = window;
        }
        return {
          type: "agent_rate_limits",
          session: this.rateLimitSession,
          weekly: this.rateLimitWeekly,
        };
      }

      default:
        return null;
    }
  }

  run(params: AgentRunParams): void {
    if (params.useStreaming) {
      if (this._isStreaming) {
        // Persistent streaming process is already alive — send the next turn
        // via message injection instead of spawning a new process. (docs/140)
        this.sendUserMessage(params.prompt);
        return;
      }
      // First turn with streaming: swap in a StreamingClaudeProcess.
      const streaming = new StreamingClaudeProcess();
      // Remove previous inner process listeners before replacing
      this.inner.removeAllListeners();
      this.inner = streaming;
      this._isStreaming = true;
      this.wireEvents(streaming);
    }

    this.inner.run({
      prompt: params.prompt,
      sessionId: params.sessionId,
      systemPrompt: params.systemPrompt,
      images: params.images,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      mcpConfigPath: params.mcpConfigPath,
      // docs/088 — names of enabled user MCP servers drive the tool allowlist.
      mcpServerNames: params.mcpServers
        ?.filter((s) => s.enabled)
        .map((s) => s.name),
      model: params.model,
      settingsPath: params.settingsPath,
      autoCreatePr: params.autoCreatePr,
    });
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    if (this.inner instanceof StreamingClaudeProcess) {
      console.log(
        `[claude-adapter] sendUserMessage → streaming (bytes=${text.length}, text=${JSON.stringify(text.slice(0, 80))})`,
      );
      this.inner.sendUserMessage(text);
      return;
    }
    // docs/140 — the orchestrator's steering gate (`runner.isStreamingActive`)
    // should have routed around this branch when the resident process is a
    // one-shot PTY ClaudeProcess. If we got here, the gate disagrees with the
    // adapter — silent no-op would make the user's message disappear with no
    // feedback. Log loudly, emit a server-facing log (so the Logs panel shows
    // a clear failure), and emit an `error` so wireAgentListeners surfaces
    // it in chat. The runner's error-path teardown is acceptable because the
    // alternative — silently swallowing the steer — was the bug the user kept
    // hitting.
    console.warn(
      `[claude-adapter] sendUserMessage called on non-streaming inner — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "log",
      "server",
      "Live steering failed: the agent process is not in streaming mode. The message was not delivered to the CLI.",
    );
    this.emit(
      "error",
      new Error(
        "Live steering could not deliver the message: the agent process is not streaming. Try sending again after the current turn finishes, or toggle live steering off.",
      ),
    );
  }

  writeStdin(data: string): void {
    this.inner.writeStdin(data);
  }

  interrupt(): void {
    this.inner.interrupt();
  }

  kill(): void {
    this.inner.kill();
  }

  /**
   * Change permission mode on the resident process. Only meaningful for the
   * persistent streaming process — the one-shot PTY path re-applies the mode
   * at every spawn, so there's nothing to do here. ShipIt → CLI mapping
   * matches what `ClaudeProcess` / `StreamingClaudeProcess` push as
   * `--permission-mode` at spawn: `plan` → `"plan"`, `guarded` → `"auto"`
   * (the CLI's classifier-gated mode), `auto` / undefined → `"default"`
   * (the no-flag default the CLI reports in its init event).
   */
  setPermissionMode(mode: PermissionMode | undefined): void {
    if (!(this.inner instanceof StreamingClaudeProcess)) return;
    const cliMode =
      mode === "plan" ? "plan" : mode === "guarded" ? "auto" : "default";
    this.inner.setPermissionMode(cliMode);
  }

  /**
   * Write a per-turn JSON config file (`--mcp-config`) bundling the built-in
   * Playwright server, the internal review bridge (docs/125, when present),
   * and any user-configured MCP servers (docs/088 — `$secret:` placeholders
   * resolved against `process.env`). Each missing-secret server is reported
   * back to the worker so it can broadcast an `mcp_server_status` SSE event.
   *
   * NOTE on cwd: `--output-dir` only governs auto-generated filenames. When
   * the agent passes a `filename` to `browser_take_screenshot` (or any tool
   * with a suggestedFilename), `@playwright/mcp` resolves it relative to its
   * own `process.cwd()` via `workspaceFile()` — NOT relative to
   * `--output-dir`. If we let the server inherit the workspace as cwd,
   * screenshots like `shot.png` land in `/workspace/` and get auto-committed.
   * We work around this by launching the server through `sh -c` with an
   * explicit `cd` into the output dir so suggested filenames also stay out
   * of the repo. See coreBundle.js:`workspaceFile()` and
   * `resolveClientFilename()`.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const configPath = `/tmp/mcp-config-${Date.now()}.json`;
    const outputDir = "/tmp/.playwright-mcp";
    // `--browser chromium` is required: our Dockerfiles install Chromium
    // (Chrome doesn't ship for Linux ARM64). Without this flag,
    // @playwright/mcp defaults to `chrome` and fails on the first browser
    // tool call with "Chromium distribution 'chrome' is not found at
    // /opt/google/chrome/chrome".
    const mcpServers: Record<string, unknown> = {
      playwright: {
        command: "sh",
        args: [
          "-c",
          `mkdir -p ${outputDir} && cd ${outputDir} && exec playwright-mcp --browser chromium --headless --no-sandbox --output-dir ${outputDir}`,
        ],
      },
    };

    // docs/125 — internal review tool. The bridge is a thin stdio→HTTP shim
    // (mcp-review-bridge.ts) launched via tsx-by-absolute-path, mirroring the
    // `gh`/`shipit` shim install in the Dockerfile (bare `tsx` fails to
    // resolve when the agent's cwd is a user repo without a tsx dep). Skipped
    // if the bridge isn't present (e.g. a stripped-down test image) so agent
    // start never fails on it.
    if (ctx.reviewBridge) {
      mcpServers["shipit-review"] = {
        command: ctx.reviewBridge.tsxBin,
        args: [ctx.reviewBridge.bridgePath],
      };
    }

    // docs/093 — internal `present` tool. Same stdio→HTTP bridge pattern as
    // the review tool; lets the agent display HTML/SVG/markdown to the user
    // in the Present tab without writing files to the workspace.
    if (ctx.presentBridge) {
      mcpServers["shipit-present"] = {
        command: ctx.presentBridge.tsxBin,
        args: [ctx.presentBridge.bridgePath],
      };
    }

    // docs/163 — built-in `voice_note` tool. Same stdio→HTTP bridge pattern;
    // the agent emits an ear-shaped summary and the orchestrator's router
    // decides delivery (native note, external webhook, or both).
    if (ctx.voiceBridge) {
      mcpServers["shipit-voice"] = {
        command: ctx.voiceBridge.tsxBin,
        args: [ctx.voiceBridge.bridgePath],
      };
    }

    // docs/088: merge user-configured MCP servers. Configs arrive UNRESOLVED
    // — `$secret:` placeholders are substituted here against the worker's own
    // process.env (populated by 087's agent-env pipeline). A server that
    // references a missing secret is dropped and reported over SSE; it never
    // blocks agent start.
    //
    // We only emit `mcp_server_status` here for the *failure* case (missing
    // secret) — that's a definitive "this server is not going to start"
    // signal we know before the CLI runs. The matching `loaded` signal is
    // emitted later when the Claude CLI's init event reports the server as
    // `connected`; see `mcp_status` channel and `wireAgentEvents()` in the
    // worker. Emitting `loaded` here would be misleading: it would mean "we
    // sent the config" rather than "the connection succeeded."
    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        mcpServers[server.name] = resolved;
      } else {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
    return {
      mcpConfigPath: configPath,
      cleanup: () => {
        try { fs.unlinkSync(configPath); } catch { /* ignore */ }
      },
    };
  }
}

/**
 * Translate a Claude CLI `mcp_servers[]` entry into ShipIt's
 * `McpServerStatus`. Observed CLI statuses: `"connected"`, `"failed"`,
 * `"needs-auth"`. Anything else is treated as a failure with the raw status
 * preserved in `reason` so we don't silently swallow a new CLI signal.
 *
 * `needs-auth` is mapped to `failed` (not a dedicated state) for Phase 1 —
 * the existing `McpServerState` union has no `needs-auth` value, and the
 * UI's red badge with the reason text conveys the right action ("connect via
 * the provider"). Phase 2's OAuth flow is what removes this gap properly.
 */
/**
 * Normalize the Claude CLI's `rate_limit_info` payload (one window) into the
 * shared `SubscriptionLimitsWindow` shape. The CLI reports `utilization` as
 * 0–100 and `resetsAt` as Unix epoch seconds.
 *
 * `resetsAt` is required — without a reset time there's nothing to render. But
 * `utilization` is optional: Claude CLI 2.1.140 only includes it once a
 * warning threshold trips (anthropics/claude-code#50518), so at normal low
 * usage we get `{rateLimitType, resetsAt}` and nothing else. In that case we
 * return `usedPct: null` so the badge can render as countdown-only and
 * upgrade to a full meter the moment a later event carries a number.
 *
 * Returns null only when `resetsAt` is unusable.
 */
function parseRateLimitWindow(
  info: { utilization?: number; resetsAt?: number } | undefined,
): SubscriptionLimitsWindow | null {
  if (!info) return null;
  const { utilization, resetsAt } = info;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  // resetsAt is epoch seconds; tolerate a ms value defensively.
  const ms = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
  const resetAt = new Date(ms).toISOString();
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return { usedPct: null, resetAt };
  }
  const usedPct = Math.min(100, Math.max(0, utilization));
  return { usedPct, resetAt };
}

export function mapCliMcpStatus(entry: ClaudeMcpServerInit): McpServerStatus {
  switch (entry.status) {
    case "connected":
      return { name: entry.name, state: "loaded" };
    case "needs-auth":
      return {
        name: entry.name,
        state: "failed",
        reason: "authentication required",
      };
    case "failed":
      return { name: entry.name, state: "failed", reason: "connection failed" };
    default:
      return {
        name: entry.name,
        state: "failed",
        reason: `unknown status: ${entry.status}`,
      };
  }
}
