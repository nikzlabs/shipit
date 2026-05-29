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
   * The permission mode the CLI engaged for this run (docs/138). When ShipIt
   * requested guarded mode (`--permission-mode auto`), `"auto"` here is the
   * authoritative confirmation that the classifier is live. Note the CLI also
   * emits an earlier `system`/`subtype:"status"` event that reports
   * `"default"` — that one is NOT this init event and should be ignored.
   */
  permissionMode?: string;
  /**
   * Real connection status for each MCP server the CLI tried to load. ShipIt
   * uses this as the authoritative liveness signal for `mcp_server_status`
   * events, since `ClaudeAdapter.writeMcpConfig()` itself only knows whether
   * secret placeholders resolved — not whether the spawned process or remote
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
  /**
   * When --replay-user-messages is active, the CLI re-emits injected user
   * messages with isReplay: true for echo deduplication. (docs/140)
   */
  isReplay?: boolean;
}

/**
 * Per-API-call token breakdown inside `result.usage.iterations`. Each entry
 * corresponds to one round-trip to the model within the turn. Critical for
 * computing "current context occupancy" — the top-level `usage.*_input_tokens`
 * fields are SUMS across every iteration, so a turn with 10 tool-use round-
 * trips reports ~10× the actual context size. The LAST iteration's
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is
 * the true context-window occupancy at turn end.
 */
export interface ClaudeUsageIteration {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  type?: string;
}

/**
 * Per-model usage summary inside `result.modelUsage`. Carries the model's
 * actual context window — used in preference to ShipIt's static
 * `MODEL_CONTEXT_WINDOWS` map so 1M-window models (e.g. Opus 4.7) get the
 * correct denominator without requiring a code change for each new model.
 */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
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
   *
   * IMPORTANT: top-level `input_tokens` / `cache_read_input_tokens` /
   * `cache_creation_input_tokens` are the SUM across all API calls in the
   * turn. For the real per-turn context occupancy, use the last entry in
   * `iterations`.
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    iterations?: ClaudeUsageIteration[];
  };
  /**
   * Per-model usage summary keyed by model name (e.g. `"claude-opus-4-7"`).
   * The CLI populates this for every model that contributed tokens to the
   * turn. `contextWindow` is the authoritative window size for the model —
   * preferred over ShipIt's static fallback map.
   */
  modelUsage?: Record<string, ClaudeModelUsage>;
  /**
   * Tool calls blocked by the guarded-mode (`--permission-mode auto`)
   * classifier during this turn (docs/138). Spike-verified shape: one entry
   * per blocked call. The orchestrator counts these for the headless
   * abort-on-repeated-blocks signal and surfaces the reasons inline.
   */
  permission_denials?: {
    tool_name: string;
    tool_use_id?: string;
    tool_input?: unknown;
  }[];
}

/**
 * Rate-limit change notification emitted by the CLI under
 * `--output-format=stream-json` whenever a subscription rate-limit window
 * changes (typically every API call for active subscribers). The CLI
 * itself derives this from Anthropic's `anthropic-ratelimit-unified-*`
 * response headers — i.e. it costs us nothing extra and avoids the
 * heavily rate-limited `/api/oauth/usage` endpoint entirely.
 *
 * One event carries exactly one window (`rateLimitType`). We act on
 * `five_hour` and `seven_day` and ignore `seven_day_opus`,
 * `seven_day_sonnet`, and `overage` — see docs/135 "Refresh strategy."
 *
 * Schema reproduced from the embedded Zod schema in the Claude CLI
 * binary (search the binary for `rate_limit_event`). Only the fields we
 * consume are typed strictly; the rest pass through as `unknown`.
 */
export interface ClaudeRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status?: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
    /** 0–100 (percentage of the window consumed). */
    utilization?: number;
  };
  session_id?: string;
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeRateLimitEvent;
