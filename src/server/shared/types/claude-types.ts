export interface ClaudeMcpServerInit {
  name: string;
  status: string;
}

export interface ClaudeSystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  model?: string;
  /** Authoritative mode; ignore the earlier status event's mode. */
  permissionMode?: string;
  mcp_servers?: ClaudeMcpServerInit[];
}

export interface ClaudeSystemStatusEvent {
  type: "system";
  subtype: "status";
  session_id?: string;
  status?: string;
}

export interface ClaudeCompactBoundaryEvent {
  type: "system";
  subtype: "compact_boundary";
  session_id?: string;
  compact_metadata?: {
    trigger?: "manual" | "auto";
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
}

export interface ClaudeBackgroundTask {
  task_id: string;
  task_type?: string;
  description?: string;
}

/** Complete list, emitted only on change; no heartbeat or replay on init. */
export interface ClaudeBackgroundTasksChangedEvent {
  type: "system";
  subtype: "background_tasks_changed";
  session_id?: string;
  tasks?: ClaudeBackgroundTask[];
}

export interface ClaudeTaskStartedEvent {
  type: "system";
  subtype: "task_started";
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  description?: string;
}

export interface ClaudeTaskUpdatedEvent {
  type: "system";
  subtype: "task_updated";
  session_id?: string;
  task_id?: string;
  patch?: { status?: string; end_time?: number };
}

export interface ClaudeTaskProgressEvent {
  type: "system";
  subtype: "task_progress";
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  last_tool_name?: string;
}

export interface ClaudeThinkingTokensEvent {
  type: "system";
  subtype: "thinking_tokens";
  session_id?: string;
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
}

/** Opens a self-woken turn, followed by init and result without a user message. */
export interface ClaudeTaskNotificationEvent {
  type: "system";
  subtype: "task_notification";
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  status?: string;
  /** Full task transcript; read summary for the report. */
  output_file?: string;
  /** Shell status or full subagent report; distinguish by the starting tool. */
  summary?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

/** Repeated init after compaction or task wake must not reset session state. */
export type ClaudeSystemEvent =
  | ClaudeSystemInitEvent
  | ClaudeSystemStatusEvent
  | ClaudeCompactBoundaryEvent
  | ClaudeBackgroundTasksChangedEvent
  | ClaudeTaskStartedEvent
  | ClaudeTaskUpdatedEvent
  | ClaudeTaskProgressEvent
  | ClaudeThinkingTokensEvent
  | ClaudeTaskNotificationEvent;

export interface ClaudeContentBlockText {
  type: "text";
  text: string;
}

export interface ClaudeContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Full input: GET /api/sessions/:id/tool-inputs/:toolUseId. */
  bodyTruncated?: true;
  diffStats?: { added: number; removed: number };
  /** Original lengths of shortened or removed string keys. */
  inputChars?: Record<string, number>;
}

export type ClaudeContentBlock = ClaudeContentBlockText | ClaudeContentBlockToolUse;

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    content: ClaudeContentBlock[];
    /** Per-call counts; some providers omit result.usage.iterations. */
    usage?: ClaudeUsageIteration;
  };
  parent_tool_use_id?: string;
  is_api_error_message?: boolean;
  /** Stable failure code; synthetic error text varies. */
  error?: string;
}

export interface ClaudeUserEvent {
  type: "user";
  message: {
    content: unknown[];
  };
  parent_tool_use_id?: string;
  isReplay?: boolean;
}

/** Last iteration's input and cache counts measure context; turn sums do not. */
export interface ClaudeUsageIteration {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  type?: string;
}

export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  /** Prefer the reported window to the static fallback. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ClaudeResultEvent {
  type: "result";
  /** "success" can include API failure: use is_error. */
  subtype: "success" | "error" | "error_max_turns" | "error_during_execution";
  is_error?: boolean;
  terminal_reason?: string;
  session_id: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  /** Counts sum all calls; use the last iteration for context occupancy. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    iterations?: ClaudeUsageIteration[];
  };
  modelUsage?: Record<string, ClaudeModelUsage>;
  permission_denials?: {
    tool_name: string;
    tool_use_id?: string;
    tool_input?: unknown;
  }[];
}

export interface ClaudeRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status?: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
    /** Fraction (0–1), not percent. */
    utilization?: number;
  };
  session_id?: string;
}

/** message_delta has final per-call usage; assistant snapshots can contain zeros. */
export interface ClaudeStreamEvent {
  type: "stream_event";
  event?: {
    type?: string;
    usage?: ClaudeUsageIteration;
  };
  parent_tool_use_id?: string | null;
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeRateLimitEvent
  | ClaudeStreamEvent;
