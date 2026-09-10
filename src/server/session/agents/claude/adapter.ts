import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ClaudeProcess, StreamingClaudeProcess } from "./process.js";
import type {
  ClaudeEvent,
  ClaudeMcpServerInit,
  ClaudeUsageIteration,
  PermissionMode,
} from "../../../shared/types.js";
import { CLAUDE_PERMISSION_MODES } from "../../../shared/types.js";
import { CLAUDE_MODELS, CLAUDE_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { unshapeClaudeModelId } from "../../../shared/spawn-routing.js";
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
import type { AgentHomeResolver } from "../../../shared/agent-home.js";
import type { McpServerStatus } from "../../../shared/types/mcp-types.js";
import type { SubscriptionLimitsWindow } from "../../../shared/types/usage-limits-types.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
} from "../playwright-mcp.js";

function textFromUserContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

export class ClaudeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "claude";

  // The CLI sends one window per event; retain the other for combined updates.
  private rateLimitSession: SubscriptionLimitsWindow | null = null;
  private rateLimitWeekly: SubscriptionLimitsWindow | null = null;

  // Providers can omit result iterations. DeepSeek supplies assistant usage;
  // GLM supplies only message_delta usage. The latest positive reading wins.
  private latestCallContextTokens: number | undefined;

  private selectedModel: string | undefined;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: CLAUDE_PERMISSION_MODES,
    toolNames: [...CLAUDE_TOOL_NAMES],
    models: CLAUDE_MODELS,
    supportsReview: true,
    supportsSteering: true,
    supportsCompaction: true,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  private inner: ClaudeProcess | StreamingClaudeProcess;
  private _isStreaming = false;
  private _permissionPromptTool: string | undefined;

  private readonly resolveHome: AgentHomeResolver | undefined;

  constructor(inner?: ClaudeProcess, opts?: { resolveHome?: AgentHomeResolver }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.inner = inner ?? new ClaudeProcess(this.resolveHome);
    this.wireEvents(this.inner);
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  private wireEvents(proc: ClaudeProcess | StreamingClaudeProcess): void {
    proc.on("event", (raw: ClaudeEvent) => {
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

  private recordCallContext(usage: ClaudeUsageIteration | undefined): void {
    if (!usage) return;
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    if (contextTokens > 0) this.latestCallContextTokens = contextTokens;
  }

  private mapEvent(raw: ClaudeEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        switch (raw.subtype) {
          case "init":
            return {
              type: "agent_init",
              agentId: "claude",
              sessionId: raw.session_id,
              model: raw.model === undefined ? undefined : unshapeClaudeModelId(raw.model, this.selectedModel),
              tools: raw.tools,
              permissionMode: raw.permissionMode,
            };
          case "status":
            if (raw.status === "compacting") {
              return { type: "agent_compaction_started", trigger: "auto" };
            }
            return null;
          case "compact_boundary": {
            const meta = raw.compact_metadata;
            const event: AgentEvent = { type: "agent_compacted" };
            if (meta?.trigger) event.trigger = meta.trigger;
            if (typeof meta?.pre_tokens === "number") event.preTokens = meta.pre_tokens;
            if (typeof meta?.post_tokens === "number") event.postTokens = meta.post_tokens;
            if (typeof meta?.duration_ms === "number") event.durationMs = meta.duration_ms;
            return event;
          }
          case "background_tasks_changed":
            return {
              type: "agent_background_tasks",
              tasks: (raw.tasks ?? []).map((t) => ({
                id: t.task_id,
                type: t.task_type,
                description: t.description,
              })),
            };
          case "task_notification":
            // Background agents finish here without a second tool_result.
            return {
              type: "agent_self_wake",
              taskId: raw.task_id,
              summary: raw.summary,
              status: raw.status,
              ...(raw.tool_use_id ? { toolUseId: raw.tool_use_id } : {}),
              ...(raw.usage
                ? {
                    usage: {
                      ...(typeof raw.usage.total_tokens === "number" ? { totalTokens: raw.usage.total_tokens } : {}),
                      ...(typeof raw.usage.tool_uses === "number" ? { toolUses: raw.usage.tool_uses } : {}),
                      ...(typeof raw.usage.duration_ms === "number" ? { durationMs: raw.usage.duration_ms } : {}),
                    },
                  }
                : {}),
            };
          case "task_started":
          case "task_updated":
            // background_tasks_changed supplies the full authoritative list.
            return null;
          case "task_progress":
            return null;
          case "thinking_tokens":
            return null;
          default:
            return null;
        }

      case "stream_event":
        if (!raw.parent_tool_use_id && raw.event?.type === "message_delta") {
          this.recordCallContext(raw.event.usage);
        }
        return null;

      case "assistant":
        if (!raw.parent_tool_use_id) this.recordCallContext(raw.message.usage);
        return {
          type: "agent_assistant",
          content: raw.message.content,
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "user":
        // Replay acknowledges delivery; the user message is already rendered.
        if (raw.isReplay) {
          return { type: "agent_user_replay", text: textFromUserContent(raw.message.content) };
        }
        return {
          type: "agent_tool_result",
          content: raw.message.content,
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "result": {
        const u = raw.usage;
        // Context uses the last call's input, not the turn's summed usage.
        let contextTokens: number | undefined;
        const lastIter = u?.iterations?.length
          ? u.iterations[u.iterations.length - 1]
          : undefined;
        if (lastIter) {
          contextTokens =
            (lastIter.input_tokens ?? 0) +
            (lastIter.cache_read_input_tokens ?? 0) +
            (lastIter.cache_creation_input_tokens ?? 0);
        } else {
          contextTokens = this.latestCallContextTokens;
        }
        this.latestCallContextTokens = undefined;
        const modelUsage = raw.modelUsage;
        let contextWindow: number | undefined;
        if (modelUsage) {
          for (const m of Object.values(modelUsage)) {
            if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
              contextWindow = m.contextWindow;
            }
          }
        }
        // API errors can carry subtype="success" with is_error=true.
        const errored = raw.is_error === true || raw.subtype !== "success";
        return {
          type: "agent_result",
          status: errored ? "error" : "success",
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
          error: errored ? raw.result : undefined,
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
    // An abnormal prior turn may have left usage without a result to clear it.
    this.latestCallContextTokens = undefined;
    if (params.useStreaming) {
      if (this._isStreaming) {
        this.sendUserMessage(params.prompt);
        return;
      }
      const streaming = new StreamingClaudeProcess(this.resolveHome);
      this.inner.removeAllListeners();
      this.inner = streaming;
      this._isStreaming = true;
      this.wireEvents(streaming);
    }

    this.selectedModel = params.model;
    this.inner.run({
      prompt: params.prompt,
      sessionId: params.sessionId,
      systemPrompt: params.systemPrompt,
      images: params.images,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      mcpConfigPath: params.mcpConfigPath,
      mcpServerNames: params.mcpServers
        ?.filter((s) => s.enabled)
        .map((s) => s.name),
      model: params.model,
      serviceRouting: params.serviceRouting,
      homeDir: params.homeDir,
      reasoningEffort: params.reasoningEffort,
      settingsPath: params.settingsPath,
      autoCreatePr: params.autoCreatePr,
      sandbox: params.sandbox,
      guardDestructiveGit: params.guardDestructiveGit,
      permissionPromptTool: this._permissionPromptTool,
    });
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    this.latestCallContextTokens = undefined;
    if (this.inner instanceof StreamingClaudeProcess) {
      console.log(
        `[claude-adapter] sendUserMessage → streaming (bytes=${text.length}, text=${JSON.stringify(text.slice(0, 80))})`,
      );
      this.inner.sendUserMessage(text);
      return;
    }
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

  setPermissionMode(mode: PermissionMode | undefined): void {
    if (!(this.inner instanceof StreamingClaudeProcess)) return;
    const cliMode =
      mode === "plan" ? "plan" : mode === "guarded" ? "auto" : "default";
    this.inner.setPermissionMode(cliMode);
  }

  compact(instructions?: string): void {
    if (this.inner instanceof StreamingClaudeProcess) {
      const trimmed = instructions?.trim();
      this.inner.sendUserMessage(trimmed ? `/compact ${trimmed}` : "/compact");
      return;
    }
    console.warn(
      "[claude-adapter] compact() called on non-streaming inner — no resident process to compact (the orchestrator should have spawned a /compact turn instead)",
    );
  }

  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const configPath = `/tmp/mcp-config-${Date.now()}.json`;
    const mcpServers: Record<string, unknown> = {
      playwright: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
      },
    };

    if (ctx.shipitBridge) {
      mcpServers.shipit = {
        command: ctx.shipitBridge.tsxBin,
        args: [ctx.shipitBridge.bridgePath],
        env: { SHIPIT_MCP_TOOLS: "present,voice,bug,permission,propose_actions" },
      };
      // CLI-only gate; exclude this tool from the model's allowlist.
      this._permissionPromptTool = "mcp__shipit__permission_prompt";
    } else {
      this._permissionPromptTool = undefined;
    }

    // Report failures now; only the CLI's connection report can establish "loaded".
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

// Header utilization is a fraction, unlike /api/oauth/usage's percentage.
// CLI 2.1.140 omits utilization below warning thresholds; null permits countdown-only display.
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
  const pct = utilization > 1 ? utilization : utilization * 100;
  const usedPct = Math.min(100, Math.max(0, pct));
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
