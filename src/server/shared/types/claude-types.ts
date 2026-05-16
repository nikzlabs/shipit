// ---- Claude CLI NDJSON event types ----

/**
 * Per-server connection status reported by the Claude CLI in its init event.
 * The CLI emits one entry per MCP server it was asked to connect to
 * (via `--mcp-config`), with a string `status` describing whether the
 * connection succeeded. Observed values include `"connected"`, `"failed"`,
 * and `"needs-auth"` — see docs/088-mcp-integration/plan.md for the full
 * mapping into ShipIt's `McpServerState`.
 */
export interface ClaudeMcpServerInit {
  name: string;
  status: string;
}

export interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  model?: string;
  /**
   * Real connection status for each MCP server the CLI tried to load. ShipIt
   * uses this as the authoritative liveness signal for `mcp_server_status`
   * events, since `generateMcpConfig()` itself only knows whether secret
   * placeholders resolved — not whether the spawned process or remote
   * endpoint actually accepted the connection. (docs/088)
   */
  mcp_servers?: ClaudeMcpServerInit[];
}

export interface ClaudeContentBlockText {
  type: "text";
  text: string;
}

export interface ClaudeContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeContentBlock = ClaudeContentBlockText | ClaudeContentBlockToolUse;

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    content: ClaudeContentBlock[];
  };
  /**
   * When the Claude CLI emits this event from a subagent (Task tool), this is
   * the tool_use id of the parent Task call. Top-level assistant events do not
   * have this field. Used by the orchestrator to render subagent calls as a
   * nested tree (109 — subagent transparency).
   */
  parent_tool_use_id?: string;
}

export interface ClaudeUserEvent {
  type: "user";
  message: {
    content: unknown[];
  };
  /** See ClaudeAssistantEvent.parent_tool_use_id. */
  parent_tool_use_id?: string;
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  /**
   * Token counts are emitted by the Claude Code CLI nested inside a `usage`
   * object (matching the Anthropic API schema), not as top-level fields.
   * Cache fields use the API's `*_input_tokens` suffix.
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;
