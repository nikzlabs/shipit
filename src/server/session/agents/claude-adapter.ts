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
import type { ClaudeEvent } from "../../shared/types.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "./agent-process.js";

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

      case "result":
        return {
          type: "agent_result",
          status: raw.subtype,
          sessionId: raw.session_id,
          cost: raw.total_cost_usd !== null && raw.total_cost_usd !== undefined
            ? { totalUsd: raw.total_cost_usd }
            : undefined,
          tokens: raw.input_tokens !== null && raw.input_tokens !== undefined
            ? {
                input: raw.input_tokens,
                output: raw.output_tokens ?? 0,
                cacheRead: raw.cache_read_tokens,
                cacheWrite: raw.cache_write_tokens,
              }
            : undefined,
          durationMs: raw.duration_ms,
          error: raw.subtype === "error" ? raw.result : undefined,
        };

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
      model: params.model,
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
