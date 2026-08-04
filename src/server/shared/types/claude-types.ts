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

export interface ClaudeSystemInitEvent {
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

/**
 * docs/178 — the CLI's `system`/`subtype:"status"` event. It reports transient
 * process status; we only act on `status:"compacting"`, which signals an
 * in-flight context compaction (the adapter maps it to
 * `agent_compaction_started`). All other statuses are ignored. NOTE: this is the
 * same event family the docs/138 init comment warns about ("an earlier
 * `subtype:"status"` event that reports `default`") — discriminating on
 * `subtype` keeps it out of the init path.
 */
export interface ClaudeSystemStatusEvent {
  type: "system";
  subtype: "status";
  session_id?: string;
  /** e.g. `"compacting"` while the CLI summarizes context. */
  status?: string;
}

/**
 * docs/178 — the CLI's `system`/`subtype:"compact_boundary"` event, emitted when
 * a context compaction completes (the conversation prefix was replaced by a
 * summary). The adapter maps it to the persisted `agent_compacted` card.
 */
export interface ClaudeCompactBoundaryEvent {
  type: "system";
  subtype: "compact_boundary";
  session_id?: string;
  /** Compaction metadata reported by the CLI. All fields best-effort. */
  compact_metadata?: {
    /** `"manual"` for `/compact`, `"auto"` when the CLI compacted on its own. */
    trigger?: "manual" | "auto";
    /** Context tokens before the compaction. */
    pre_tokens?: number;
    /** Context tokens after the compaction. */
    post_tokens?: number;
    /** Wall-clock duration of the compaction in ms. */
    duration_ms?: number;
  };
}

/**
 * docs/235 — one entry in the CLI's background-task list. `task_type` is the
 * CLI's own discriminator (e.g. `"local_bash"` for a `Bash(run_in_background)`
 * job); `description` is the command or label the CLI shows for it.
 */
export interface ClaudeBackgroundTask {
  task_id: string;
  task_type?: string;
  description?: string;
}

/**
 * docs/235 — the CLI's `system`/`subtype:"background_tasks_changed"` event. The
 * `tasks` array is the **complete current list**, not a delta, so any single
 * event fully re-states the truth (empty array = drained). It is emitted only on
 * change: neither a new turn nor a fresh `init` re-states an outstanding list,
 * and there is no heartbeat — see the reliability section of docs/235 for why
 * the orchestrator therefore decays its copy rather than trusting it forever.
 */
export interface ClaudeBackgroundTasksChangedEvent {
  type: "system";
  subtype: "background_tasks_changed";
  session_id?: string;
  tasks?: ClaudeBackgroundTask[];
}

/** docs/235 — a background task started. Edge signal; the level lives in {@link ClaudeBackgroundTasksChangedEvent}. */
export interface ClaudeTaskStartedEvent {
  type: "system";
  subtype: "task_started";
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  description?: string;
}

/** docs/235 — a background task changed state (`patch.status` e.g. `"completed"`). */
export interface ClaudeTaskUpdatedEvent {
  type: "system";
  subtype: "task_updated";
  session_id?: string;
  task_id?: string;
  patch?: { status?: string; end_time?: number };
}

/**
 * docs/235 — a background task finished and the CLI is waking itself to react.
 * This is the edge that opens a **self-woken turn**: on the wire it is
 * immediately followed by a fresh `system/init` and, later, a `result`, with no
 * user message in between.
 */
export interface ClaudeTaskNotificationEvent {
  type: "system";
  subtype: "task_notification";
  session_id?: string;
  task_id?: string;
  tool_use_id?: string;
  /** e.g. `"completed"`. */
  status?: string;
  /** Path (inside the container) the CLI wrote the task's output to. */
  output_file?: string;
  /** Human-readable one-liner, e.g. `Background command "npm test" completed (exit code 0)`. */
  summary?: string;
}

/**
 * The CLI's `system` events, discriminated by `subtype`. `init` is the
 * once-per-session handshake; `status` / `compact_boundary` carry the docs/178
 * compaction signals; the `task_*` / `background_tasks_changed` family carries
 * the docs/235 background-task liveness signals. A mid-stream second `init` (the
 * CLI re-inits after a compaction, and again when a background task wakes it) is
 * the same shape as the first — the orchestrator, not the type, is responsible
 * for not resetting session/permission state on it.
 */
export type ClaudeSystemEvent =
  | ClaudeSystemInitEvent
  | ClaudeSystemStatusEvent
  | ClaudeCompactBoundaryEvent
  | ClaudeBackgroundTasksChangedEvent
  | ClaudeTaskStartedEvent
  | ClaudeTaskUpdatedEvent
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
  /**
   * docs/244 — one or more input keys were shortened or removed on the serve
   * path; the whole input is available from
   * `GET /api/sessions/:id/tool-inputs/:toolUseId`. Which keys, and why, is
   * `inputKeyTreatment` (`shared/transcript-input-policy.ts`).
   */
  bodyTruncated?: true;
  /** Line stats for the `+N -M` summary, computed before the body was stripped. */
  diffStats?: { added: number; removed: number };
  /**
   * Original character length of each shortened or removed *string* key, for the
   * labels the transcript draws from a length it no longer holds — today just
   * `SubagentCall`'s `Prompt (N chars)` toggle (SHI-296).
   */
  inputChars?: Record<string, number>;
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
  /**
   * True when this "assistant" message is a SYNTHETIC error envelope the CLI
   * emits in place of model output (`message.model` is `"<synthetic>"`), not
   * something the model said. An unauthenticated turn's only "reply" is one of
   * these, carrying the text `Not logged in · Please run /login`.
   * See {@link error}.
   */
  is_api_error_message?: boolean;
  /**
   * Machine-readable failure code on a synthetic API-error message — e.g.
   * `"authentication_failed"`. Present only alongside
   * {@link is_api_error_message}; it is the reliable signal, since the human
   * text varies by failure mode. Verified against CLI 2.1.219.
   */
  error?: string;
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
  /**
   * The CLI's terminal classification — NOT a success/failure flag.
   * `subtype: "success"` only means the turn ran to a normal end-of-turn
   * boundary: an API failure (auth, quota, overload) also ends
   * `subtype: "success"` with `is_error: true`. `error_during_execution` is
   * what an interrupt produces. `"error"` is a legacy value kept for fixtures
   * and adapters that still emit it; the real CLI never sends it. Read
   * {@link is_error} to decide whether the turn failed. Verified against CLI
   * 2.1.219.
   */
  subtype: "success" | "error" | "error_max_turns" | "error_during_execution";
  /** Authoritative "this turn failed" flag, independent of {@link subtype}. */
  is_error?: boolean;
  /** Why the turn ended — e.g. `"api_error"` when an upstream call failed. */
  terminal_reason?: string;
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
    /**
     * 0–1 **fraction** of the window consumed — forwarded verbatim from the
     * upstream `anthropic-ratelimit-unified-{5h,7d}-utilization` header, which
     * reads e.g. `0.06` where `/api/oauth/usage` reports `6.0`. Scale by 100
     * before rendering (`parseRateLimitWindow` in the Claude adapter).
     */
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
