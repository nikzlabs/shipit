// ---- Claude CLI NDJSON event types ----

export interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  model?: string;
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
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;
