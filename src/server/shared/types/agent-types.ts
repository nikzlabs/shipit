// ---- Agent types (multi-agent support) ----

import type { EventEmitter } from "node:events";
import type { ImageAttachment, PermissionMode } from "./attachment-types.js";
import type { McpServerConfig, McpServerStatus } from "./mcp-types.js";

// ---- Agent identity ----

export type AgentId = "claude" | "codex";

/**
 * The permission modes the Claude Code adapter supports (docs/138). Single
 * source of truth shared by the session adapter (`claude-adapter.ts`) and the
 * orchestrator-side static registry (`agent-registry.ts`) so the two can't
 * drift. `guarded` is the classifier-gated mode (CLI `--permission-mode auto`).
 */
export const CLAUDE_PERMISSION_MODES: PermissionMode[] = ["auto", "plan", "guarded"];

// ---- Agent capabilities ----

export interface AgentCapabilities {
  /** Whether the agent can resume a previous conversation (e.g. --resume). */
  supportsResume: boolean;
  /** Whether the agent accepts image attachments in prompts. */
  supportsImages: boolean;
  /** Whether the agent accepts an explicit system prompt. */
  supportsSystemPrompt: boolean;
  /** Whether the agent supports permission/sandbox modes. */
  supportsPermissionModes: boolean;
  /** Which permission modes are available (empty if unsupported). */
  supportedPermissionModes: PermissionMode[];
  /** Tool names the CLI exposes (for UI mapping). */
  toolNames: string[];
  /** Known model identifiers for this agent. */
  models: string[];
  /**
   * Whether the agent backend can run the chat-native AI review flow
   * (docs/125-chat-native-ai-review). The feature requires both a subagent
   * primitive and custom MCP tool registration; we collapse those two
   * requirements into a single feature-shaped flag because the AND is the
   * only thing we ever check. Claude Code: true. Codex: false. When a
   * future adapter can satisfy both, flip this on.
   */
  supportsReview: boolean;
  /**
   * Whether the agent supports live steering — injecting user messages mid-turn
   * or starting next turns without respawning. Claude uses --input-format
   * stream-json; Codex uses turn/steer. (docs/140)
   */
  supportsSteering: boolean;
  /**
   * Per-CLI dotfolder for project skills, e.g. `.claude` or `.codex`. Project
   * skills live at `<workspace>/<skillsDirName>/skills/<name>/SKILL.md` and the
   * marketplace installer writes here. Single source of truth so adding a new
   * backend (`.cursor`, `.gemini`) doesn't sprout new branches at every call
   * site. (docs/155)
   */
  skillsDirName: string;
  /**
   * Character the user types in chat to invoke a skill — Claude uses `/`,
   * Codex uses `$`. Read by the marketplace install service (to render the
   * invocation token in the install confirmation) and by the client's message
   * composer (to insert the right prefix when picking a skill from the menu).
   * (docs/138, docs/155)
   */
  skillInvocationPrefix: string;
}

// ---- Normalized event schema ----

/** Emitted once when the agent starts a conversation. */
export interface AgentInitEvent {
  type: "agent_init";
  agentId: AgentId;
  sessionId: string;
  model?: string;
  tools?: string[];
  /**
   * The permission mode the CLI actually engaged for this run, as reported by
   * the init event (docs/138). For Claude Code, `"auto"` here means the
   * classifier-gated guarded mode is live. If guarded was requested but this
   * reports anything else, guarded was unavailable (plan/admin/model
   * constraint) and the run silently dropped to default — the orchestrator
   * uses this as the authoritative availability signal. Undefined for adapters
   * that don't surface it.
   */
  permissionMode?: string;
}

/** An assistant turn — text and/or tool invocations. */
export interface AgentAssistantEvent {
  type: "agent_assistant";
  content: AgentContentBlock[];
  /**
   * When the agent emits this event from inside a subagent (e.g. Claude's Task
   * tool), this is the tool_use id of the parent Task call. Top-level
   * assistant events leave this undefined. The client uses it to render the
   * subagent's work as a nested tree under the parent Task tool call rather
   * than flattening it into the main conversation. (109 — subagent transparency)
   */
  parentToolUseId?: string;
  /**
   * When true, this event carries the FULL final text of a streamed assistant
   * message — used by adapters (Codex) that previously emitted incremental
   * deltas via individual `agent_assistant` events. The orchestrator uses this
   * as the authoritative `turnSummary` (single-line commit / activity label)
   * but does NOT append the text to `accumulatedText` or `chatMessageGroups`,
   * because the deltas already populated those. Without this signal,
   * `turnSummary` ends up as just the last delta (often a single character
   * like ".") which became the commit message.
   */
  isStreamCompletion?: boolean;
}

/** Tool results flowing back to the agent. */
export interface AgentToolResultEvent {
  type: "agent_tool_result";
  content: unknown[];
  /** See AgentAssistantEvent.parentToolUseId. */
  parentToolUseId?: string;
}

/** Final result of a turn. */
export interface AgentResultEvent {
  type: "agent_result";
  status: "success" | "error";
  sessionId: string;
  cost?: { totalUsd: number };
  /**
   * Turn-wide token totals — these are SUMS across every API call (iteration)
   * in the turn. Use them for cost/billing rollups, NOT for "current context
   * size" (which would be over-counted by N× for an N-iteration turn). The
   * authoritative context-occupancy reading is `contextTokens` below.
   */
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /**
   * Real context-window occupancy at turn end: input + cache_read + cache_create
   * from the LAST API call in the turn. The Claude CLI exposes this via
   * `result.usage.iterations[]`. For single-call turns this equals the sum;
   * for multi-call (tool-use) turns it is dramatically smaller. Drives the
   * context dial. Adapters that can't break down per-iteration leave this
   * undefined and the client falls back to summing.
   */
  contextTokens?: number;
  /**
   * Model's context window in tokens, as reported by the backend's
   * `result.modelUsage[<model>].contextWindow`. Preferred over ShipIt's
   * static `MODEL_CONTEXT_WINDOWS` map so models like Opus 4.7 (1M window)
   * automatically get the right denominator. Undefined when the adapter
   * can't surface it.
   */
  contextWindow?: number;
  durationMs?: number;
  error?: string;
  /**
   * Tool calls the guarded-mode classifier blocked during this turn (docs/138).
   * Each entry is one blocked call. A single block does NOT abort the turn (the
   * model re-routes); the Claude CLI aborts a headless (`-p`) run only after its
   * 3-consecutive / 20-total threshold. The orchestrator surfaces the denial
   * reason(s) inline so a guarded turn never fails silently. Empty/undefined
   * when nothing was blocked. Note: model self-refusals are NOT classifier
   * denials and never appear here.
   */
  permissionDenials?: { toolName: string; toolUseId?: string; toolInput?: unknown }[];
}

/**
 * Subscription rate-limit snapshot pushed by an agent backend mid-turn.
 *
 * - **Codex** emits this from the `account/rateLimits/updated` JSON-RPC
 *   notification its app-server streams — same numbers it draws its own
 *   `/status` line from. Both windows arrive in a single event.
 * - **Claude** emits it from the CLI's `rate_limit_event` stream messages
 *   (under `--output-format=stream-json`), which the CLI itself derives
 *   from Anthropic's `anthropic-ratelimit-unified-*` API response headers.
 *   The CLI emits one window per event, so `ClaudeAdapter` accumulates the
 *   last-known five_hour + seven_day and re-emits this combined shape on
 *   every change.
 *
 * The orchestrator routes both into the subscription-limits badge via
 * `recordAgentRateLimits` (see index.ts and the per-provider
 * `setRateLimits()` methods). Percentages are 0–100; `resetAt` is an ISO
 * timestamp. Either window may be null when the backend has only ever
 * reported one.
 */
export interface AgentRateLimitsEvent {
  type: "agent_rate_limits";
  /**
   * Rolling short-window quota (Claude: 5h, Codex: 5h). `usedPct` is null
   * when the provider only reported the window's existence and its reset
   * time but not the utilization (Claude CLI 2.1.140 does this below its
   * warning thresholds — see anthropics/claude-code#50518).
   */
  session: { usedPct: number | null; resetAt: string } | null;
  /** Weekly quota. */
  weekly: { usedPct: number | null; resetAt: string } | null;
}

export type AgentEvent =
  | AgentInitEvent
  | AgentAssistantEvent
  | AgentToolResultEvent
  | AgentResultEvent
  | AgentRateLimitsEvent;

/** Unified content blocks (text or tool use). */
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// ---- Run parameters ----

export interface AgentRunParams {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd: string;
  permissionMode?: PermissionMode;
  /** Path to MCP config JSON file (e.g., for Playwright browser tools). */
  mcpConfigPath?: string;
  /**
   * User-configured MCP servers (docs/088). Configs are UNRESOLVED — `env`
   * and `headers` may still contain `$secret:` placeholders. The adapter's
   * `writeMcpConfig()` resolves them against its own `process.env`.
   * Raw secret values never travel in this payload.
   */
  mcpServers?: McpServerConfig[];
  /** Model alias or ID to use (e.g., "sonnet", "opus", "gpt-5.4"). */
  model?: string;
  /**
   * Path to a Claude Code settings file (passed as `--settings`). The
   * orchestrator always points this at /etc/shipit/managed-settings.json for
   * the `claude` agent so the PreToolUse branch-block hook is active.
   * Claude-only; other adapters ignore it. See docs/130-block-branch-ops/plan.md.
   */
  settingsPath?: string;
  /**
   * When true, the Claude adapter sets SHIPIT_AUTO_CREATE_PR=1 in the CLI
   * environment, which the managed-settings.json Stop hook self-gates on to
   * enforce PR creation. Claude-only. See docs/129-stop-hook-pr-enforcement/plan.md.
   */
  autoCreatePr?: boolean;
  /**
   * When true, the Claude adapter spawns with --input-format stream-json
   * for live steering. Ignored by non-streaming adapters. (docs/140)
   */
  useStreaming?: boolean;
}

// ---- Per-agent MCP config writer (docs/155 hair 10) ----

/**
 * Resolved paths to the internal review MCP bridge (docs/125). The worker
 * resolves these once and hands them to the adapter so the adapter doesn't
 * have to know where the bridge lives in the session worker layout.
 */
export interface AgentMcpReviewBridge {
  tsxBin: string;
  bridgePath: string;
}

/**
 * Resolved paths to the internal present MCP bridge (docs/093). Same shape
 * and lifecycle as {@link AgentMcpReviewBridge} — kept as a separate type so
 * the two bridges can evolve independently and a future adapter can choose
 * to expose one without the other.
 */
export interface AgentMcpPresentBridge {
  tsxBin: string;
  bridgePath: string;
}

/**
 * Resolved paths to the internal voice-note MCP bridge (docs/163). Same shape
 * and lifecycle as the review/present bridges — the agent calls the built-in
 * `voice_note` tool and the bridge forwards the payload to the worker.
 */
export interface AgentMcpVoiceBridge {
  tsxBin: string;
  bridgePath: string;
}

/**
 * Per-spawn context the worker passes into `AgentProcess.writeMcpConfig()`.
 *
 * The adapter owns the CLI-specific wire format (Claude: `--mcp-config` JSON
 * file; Codex: `~/.codex/config.toml` block; Cursor: `mcp.json`). The worker
 * owns the cross-cutting context — the user-configured server list, the
 * review-bridge install paths, and the SSE channel that reports server-level
 * failures (e.g. missing secrets).
 */
export interface AgentMcpWriteContext {
  /**
   * User-configured MCP servers (docs/088). Strings still carry `$secret:` /
   * `$platform:` placeholders — the adapter substitutes them against
   * `process.env` via `resolveMcpServer()` before writing them out.
   */
  servers: McpServerConfig[];
  /**
   * The internal review bridge (docs/125), or `null` when the worker can't
   * locate the bridge files (stripped-down test image). Adapters that
   * support the review tool skip the entry when this is null; others ignore it.
   */
  reviewBridge: AgentMcpReviewBridge | null;
  /**
   * The internal present bridge (docs/093), or `null` when the worker can't
   * locate the bridge files. Adapters add it as another MCP entry so the
   * agent CLI can call the `present` tool.
   */
  presentBridge: AgentMcpPresentBridge | null;
  /**
   * The internal voice-note bridge (docs/163), or `null` when the worker can't
   * locate the bridge files. Adapters add it as another MCP entry so the agent
   * CLI can call the built-in `voice_note` tool.
   */
  voiceBridge: AgentMcpVoiceBridge | null;
  /**
   * Surface a server-level failure to the worker so it can broadcast an
   * `mcp_server_status` SSE event. Called when an entry has to be dropped
   * (e.g. missing secret); never blocks agent start.
   */
  onServerFailed: (name: string, reason: string) => void;
}

/**
 * Result of `AgentProcess.writeMcpConfig()`. Every field is optional — an
 * adapter that doesn't need a CLI-side config file (because it writes to a
 * fixed location) returns `{}` and signals nothing back to the worker.
 */
export interface AgentMcpWriteResult {
  /**
   * Filesystem path to a Claude-style MCP JSON config; passed back into
   * `run()` via `params.mcpConfigPath`. Codex/Cursor leave this undefined
   * because their CLIs read from a fixed location (e.g. `config.toml`).
   */
  mcpConfigPath?: string;
  /**
   * Env vars the worker must set on the child process for this run. Codex
   * uses this to expose `$secret:`-resolved values via env indirection
   * without persisting the raw secret to `config.toml`.
   */
  runtimeEnv?: Record<string, string>;
  /**
   * Called by the worker when the agent's `done` event fires. Used by
   * Claude to unlink the per-turn JSON file.
   */
  cleanup?: () => void;
}

// ---- AgentProcess interface ----

export interface AgentProcessEvents {
  event: [AgentEvent];
  done: [exitCode: number];
  error: [Error];
  auth_required: [];
  log: [source: string, text: string];
  /**
   * Per-MCP-server runtime status (docs/088-mcp-integration). Emitted by
   * adapters whose underlying CLI surfaces real connection state — Claude
   * Code reports this in its init event's `mcp_servers` field. Adapters
   * that can't observe MCP liveness (e.g., Codex) simply never emit this.
   *
   * Each emission carries the full set of servers reported by the CLI in
   * that observation, so consumers can replace state per-server without
   * tracking which entries dropped out of a partial update.
   */
  mcp_status: [McpServerStatus[]];
}

/**
 * The AgentProcess interface that all adapters implement.
 * Extends EventEmitter with typed events.
 */
export interface AgentProcess extends EventEmitter<AgentProcessEvents> {
  readonly agentId: AgentId;
  readonly capabilities: AgentCapabilities;

  /** Start the agent with the given parameters. */
  run(params: AgentRunParams): void;
  /** Write data to the running process's stdin. */
  writeStdin(data: string): void;
  /**
   * Inject a user message into the running turn (live steering) or send the
   * next message on a persistent streaming process. For non-streaming adapters
   * defaults to writeStdin. (docs/140)
   */
  sendUserMessage(text: string, opts?: { images?: ImageAttachment[] }): void;
  /**
   * True when this adapter owns a persistent streaming process (--input-format
   * stream-json for Claude). Post-turn lifecycle differs: done fires only on
   * process exit, not on turn end. (docs/140)
   */
  readonly isStreaming: boolean;
  /** Interrupt the running process (Ctrl+C equivalent). Falls back to kill. */
  interrupt(): void;
  /** Kill the running process. */
  kill(): void;
  /**
   * Change the resident process's permission mode mid-stream without a
   * restart. Optional — only the streaming Claude path supports it via the
   * CLI's `set_permission_mode` control_request (docs/138, docs/140). The
   * one-shot PTY path doesn't need it because each turn spawns fresh with
   * the requested mode; adapters without a control channel may omit it.
   */
  setPermissionMode?(mode: PermissionMode | undefined): void;
  /**
   * Write whatever MCP configuration this CLI expects before the worker
   * calls `run()`. Each backend owns its own wire format (Claude:
   * `--mcp-config` JSON; Codex: `~/.codex/config.toml`; future Cursor:
   * `mcp.json`); the worker treats them uniformly via the result shape.
   *
   * (docs/155 — hair 10) Replaces the per-agent `if (agentId === "claude")`
   * / `if (agentId === "codex")` branches that used to live in
   * `session-worker.ts`.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult;
}
