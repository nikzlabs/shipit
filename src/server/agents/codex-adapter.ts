/**
 * CodexAdapter — wraps CodexProcess to implement the AgentProcess interface,
 * translating Codex CLI JSONL events into normalized AgentEvent.
 *
 * The Codex CLI uses a different event model than Claude Code CLI:
 *
 *   thread.started  → agent_init
 *   item (agent_message, command_execution, file_change) → agent_assistant
 *   turn.completed  → agent_result (success)
 *   turn.failed     → agent_result (error)
 *
 * Key differences from Claude:
 * - No session resume support (stateless exec mode)
 * - No image input support
 * - No system prompt flag (uses CODEX.md / project docs instead)
 * - No built-in permission modes (uses approval modes: suggest/auto-edit/full-auto)
 * - Cost is not reported by the CLI; only token counts are available
 */

import { EventEmitter } from "node:events";
import { CodexProcess } from "./codex-process.js";
import type { CodexEvent, CodexItemEvent } from "./codex-process.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentContentBlock,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "./agent-process.js";

/** Map Codex approval modes to ShipIt permission modes. */
function permissionToApprovalMode(
  permissionMode?: string,
): "suggest" | "auto-edit" | "full-auto" {
  switch (permissionMode) {
    case "plan":
      return "suggest";
    case "normal":
      return "auto-edit";
    case "auto":
    default:
      return "full-auto";
  }
}

export class CodexAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "codex";

  readonly capabilities: AgentCapabilities = {
    supportsResume: false,
    supportsImages: false,
    supportsSystemPrompt: false,
    supportsPermissionModes: true,
    supportedPermissionModes: ["auto", "plan", "normal"],
    toolNames: ["shell", "file_write", "file_read", "file_edit", "web_search"],
    models: ["o4-mini", "gpt-5-codex", "gpt-5-codex-mini", "gpt-5"],
  };

  private inner: CodexProcess;
  private threadId: string | null = null;
  private turnStartTime: number | null = null;

  constructor(inner?: CodexProcess) {
    super();
    this.inner = inner ?? new CodexProcess();
    this.wireEvents();
  }

  /** Forward and translate events from the inner CodexProcess. */
  private wireEvents(): void {
    this.inner.on("event", (raw: CodexEvent) => {
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

  /** Convert a raw Codex CLI event into the normalized AgentEvent schema. */
  private mapEvent(raw: CodexEvent): AgentEvent | null {
    switch (raw.type) {
      case "thread.started":
        this.threadId = raw.thread_id;
        return {
          type: "agent_init",
          agentId: "codex",
          sessionId: raw.thread_id,
          tools: this.capabilities.toolNames,
        };

      case "turn.started":
        this.turnStartTime = Date.now();
        return null;

      case "turn.completed":
        return {
          type: "agent_result",
          status: "success",
          sessionId: this.threadId ?? "unknown",
          tokens: raw.usage
            ? {
                input: raw.usage.input_tokens ?? 0,
                output: raw.usage.output_tokens ?? 0,
                cacheRead: raw.usage.cached_input_tokens,
              }
            : undefined,
          durationMs: this.turnStartTime
            ? Date.now() - this.turnStartTime
            : undefined,
        };

      case "turn.failed":
        return {
          type: "agent_result",
          status: "error",
          sessionId: this.threadId ?? "unknown",
          error: raw.error?.message ?? "Turn failed",
          durationMs: this.turnStartTime
            ? Date.now() - this.turnStartTime
            : undefined,
        };

      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.mapItemEvent(raw);

      case "error": {
        // Codex emits transient "Reconnecting... N/5" errors — treat as log
        const msg = raw.message ?? "";
        if (msg.toLowerCase().includes("reconnect")) {
          this.emit("log", "server", `Codex: ${msg}`);
          return null;
        }
        return {
          type: "agent_result",
          status: "error",
          sessionId: this.threadId ?? "unknown",
          error: msg,
        };
      }

      default:
        return null;
    }
  }

  /** Map Codex item events to AgentAssistantEvent or AgentToolResultEvent. */
  private mapItemEvent(raw: CodexItemEvent): AgentEvent | null {
    const item = raw.item;
    if (!item) return null;

    switch (item.type) {
      case "agent_message": {
        if (!item.text) return null;
        const content: AgentContentBlock[] = [
          { type: "text", text: item.text },
        ];
        return { type: "agent_assistant", content };
      }

      case "command_execution": {
        // Map to a tool_use block so the client renders it like a shell command
        const content: AgentContentBlock[] = [
          {
            type: "tool_use",
            id: item.id,
            name: "shell",
            input: {
              command: item.command ?? "",
              ...(item.exit_code != null ? { exit_code: item.exit_code } : {}),
              ...(item.aggregated_output
                ? { output: item.aggregated_output }
                : {}),
              ...(item.status ? { status: item.status } : {}),
            },
          },
        ];
        // On completion, also include the output as a tool result
        if (raw.type === "item.completed" && item.aggregated_output) {
          return { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: item.id, content: item.aggregated_output }] };
        }
        return { type: "agent_assistant", content };
      }

      case "file_change": {
        // Emit each file change as a tool_use block
        const content: AgentContentBlock[] = (item.changes ?? []).map(
          (change, i) => ({
            type: "tool_use" as const,
            id: `${item.id}-${i}`,
            name: change.kind === "delete" ? "file_write" : change.kind === "add" ? "file_write" : "file_edit",
            input: {
              file_path: change.path,
              kind: change.kind,
              ...(item.status ? { status: item.status } : {}),
            },
          }),
        );
        if (content.length === 0) return null;
        return { type: "agent_assistant", content };
      }

      case "web_search": {
        const content: AgentContentBlock[] = [
          {
            type: "tool_use",
            id: item.id,
            name: "web_search",
            input: {},
          },
        ];
        return { type: "agent_assistant", content };
      }

      case "reasoning":
        // Reasoning summaries — emit as text
        if (!item.text) return null;
        return {
          type: "agent_assistant",
          content: [{ type: "text", text: item.text }],
        };

      case "mcp_tool_call": {
        const content: AgentContentBlock[] = [
          {
            type: "tool_use",
            id: item.id,
            name: item.tool ?? "mcp_tool",
            input: {
              server: item.server,
              ...(item.status ? { status: item.status } : {}),
            },
          },
        ];
        return { type: "agent_assistant", content };
      }

      case "todo_list":
      case "error":
        // todo_list and error items — skip or log
        return null;

      default:
        return null;
    }
  }

  run(params: AgentRunParams): void {
    const approvalMode = permissionToApprovalMode(params.permissionMode);
    this.inner.run(
      params.prompt,
      approvalMode,
      undefined, // model — use Codex default
      params.cwd,
    );
  }

  writeStdin(data: string): void {
    this.inner.writeStdin(data);
  }

  kill(): void {
    this.inner.kill();
  }
}
