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
   * and `headers` may still contain `$secret:` placeholders. The worker
   * resolves them against its own `process.env` in `generateMcpConfig()`.
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
}
