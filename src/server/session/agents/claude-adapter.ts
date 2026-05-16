/**
 * ClaudeAdapter — wraps the existing ClaudeProcess to implement the
 * AgentProcess interface, translating ClaudeEvent → AgentEvent.
 *
 * This is a thin wrapper: the real CLI interaction logic stays in
 * ClaudeProcess. The adapter adds event normalization and capability
 * reporting.
 */

import { EventEmitter } from "node:events";
import { ClaudeProcess } from "../claude.js";
import type { ClaudeEvent, ClaudeMcpServerInit } from "../../shared/types.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "./agent-process.js";
import type { McpServerStatus } from "../../shared/types/mcp-types.js";

export class ClaudeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "claude";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: ["auto", "plan", "normal"],
    toolNames: [
      "Write", "Read", "Edit", "Bash", "Glob", "Grep",
      "WebFetch", "WebSearch", "AskUserQuestion",
    ],
    models: ["sonnet", "opus", "haiku"],
    // Claude Code has both a subagent primitive (the Task tool) and custom
    // MCP tool registration via mcpConfigPath, which 125 needs.
    supportsReview: true,
  };

  private inner: ClaudeProcess;

  constructor(inner?: ClaudeProcess) {
    super();
    this.inner = inner ?? new ClaudeProcess();
    this.wireEvents();
  }

  /** Forward and translate events from the inner ClaudeProcess. */
  private wireEvents(): void {
    this.inner.on("event", (raw: ClaudeEvent) => {
      // docs/088: when the CLI reports per-MCP-server connection status in
      // its init event, surface that as a separate `mcp_status` emission so
      // the worker can broadcast it as the authoritative liveness signal —
      // overriding the speculative `loaded`/`failed` that `generateMcpConfig`
      // emits based on placeholder resolution alone.
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

    this.inner.on("done", (code: number) => {
      this.emit("done", code);
    });

    this.inner.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.inner.on("auth_required", () => {
      this.emit("auth_required");
    });

    this.inner.on("log", (source: string, text: string) => {
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
        };
      }

      default:
        return null;
    }
  }

  run(params: AgentRunParams): void {
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

  writeStdin(data: string): void {
    this.inner.writeStdin(data);
  }

  interrupt(): void {
    this.inner.interrupt();
  }

  kill(): void {
    this.inner.kill();
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
