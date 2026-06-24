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

/**
 * Reasoning/effort options an agent exposes. The control's name and value set
 * differ per agent (Claude Code `--effort`: low…max; Codex
 * `model_reasoning_effort`: none…xhigh), so the registry owns the per-agent
 * values and the client renders them. A stored selection absent from this set —
 * or no stored selection at all — means "pass no flag", i.e. the CLI's native
 * default. See docs/217-per-agent-reasoning.
 */
export interface AgentReasoningCapability {
  /** Control label, e.g. "Reasoning" (claude) or "Reasoning effort" (codex). */
  label: string;
  /** Selectable effort levels. Does NOT include the implicit "Default"/no-flag entry. */
  options: { value: string; label: string }[];
}

/**
 * docs/217 — per-agent defaults applied when an agent is invoked as a SUB-agent
 * (`shipit agent run --agent <id>` from inside another session). A grouped
 * object (not a scalar) so the "Sub-agent defaults" section can grow: it started
 * with `reasoningEffort` and now also carries a default `model`. Each field
 * absent ⇒ the sub-agent falls back to the backend's native default (no
 * `--effort` flag; `models[0]` for the model).
 */
export interface SubAgentDefaults {
  /** Reasoning effort the sub-agent runs with (a value from `reasoning.options`). */
  reasoningEffort?: string;
  /** Model alias/id the sub-agent runs with (a value from the agent's `models`). */
  model?: string;
}

/**
 * A write patch for {@link SubAgentDefaults}. An explicit `null` for a field
 * clears it (reverting to the backend's native default); `undefined`/absent
 * leaves it unchanged.
 */
export interface SubAgentDefaultsPatch {
  reasoningEffort?: string | null;
  model?: string | null;
}

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
   * Reasoning/effort options this agent exposes, if any. Absent for agents with
   * no reasoning knob. See docs/217-per-agent-reasoning.
   */
  reasoning?: AgentReasoningCapability;
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
   * Whether the agent backend can compact its own context — both summarizing on
   * demand (the `/compact` composer command) and emitting native compaction
   * signals ShipIt renders inline (docs/178). Claude Code: true (the CLI's
   * `/compact` + `system/compact_boundary` stream events). Codex: true (the
   * app-server's `thread/compact/start` RPC + `contextCompaction` items). Gates
   * both the `/` autocomplete entry and the `agent.compact()` trigger path.
   */
  supportsCompaction: boolean;
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

/**
 * A live-steer (`turn/steer` for Codex, NDJSON user-message for Claude) the
 * backend refused to apply mid-turn. Codex rejects steering during **review**
 * and **manual compaction** turns (`ActiveTurnNotSteerable`); rather than let
 * the message vanish (it was already optimistically rendered), the adapter
 * emits this so the orchestrator can fall back to the queue and run it as the
 * next turn. `text` is the steer payload the adapter attempted to send.
 * (docs/140)
 */
export interface AgentSteerRejectedEvent {
  type: "agent_steer_rejected";
  text: string;
}

/**
 * docs/140 — a live steer's **delivery acknowledgment**: the backend confirmed
 * it accepted the steered user message into the running turn.
 *
 * - **Claude** emits this from its `--replay-user-messages` echo of an injected
 *   user message (`isReplay:true`). The echo fires for every accepted user
 *   message (including the turn's initial prompt), so the orchestrator matches
 *   `text` against the steer it sent rather than assuming every replay is a steer.
 * - **Codex** emits this when its `turn/steer` JSON-RPC request *resolves*
 *   (the app-server accepted the steer). A rejected `turn/steer` instead emits
 *   {@link AgentSteerRejectedEvent}.
 *
 * Either way the orchestrator marks the matching steer `delivered` so it is not
 * re-queued at turn end. An un-acked steer (one that fell into the turn-end gap)
 * IS re-queued.
 *
 * A live steer is written to the resident process's stdin while `running` is
 * still `true`, but the CLI only applies a steered message at its next decision
 * point (a tool return). When the model is *wrapping up* there is no next
 * decision point, so a steer injected in that window never lands in the turn —
 * the turn ends with a `result` and the message is silently lost (it stays in
 * the transcript but the agent never acts on it). The CLI echoes every user
 * message it actually accepts into a turn; the orchestrator matches this echo
 * against the steer it sent, and any steer NOT echoed before the turn's
 * `result` is re-queued so it runs as a fresh turn instead of vanishing.
 *
 * `text` is the echoed user-message text (the assembled prompt the CLI
 * received). NOT chat content — `agent-listeners` consumes it for ack tracking
 * and returns before the message accumulator (like `agent_steer_rejected`).
 */
export interface AgentUserReplayEvent {
  type: "agent_user_replay";
  text: string;
}

/**
 * docs/178 — a context compaction has *started*. Transient progress only: the
 * orchestrator forwards it as an emit-only "Compacting…" indicator and never
 * persists it (it has no place in the scrollback once the matching
 * {@link AgentCompactedEvent} card lands). Both CLIs may compact unsolicited
 * mid-turn, so this can arrive without ShipIt having triggered it.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"status"` event with
 *   `status:"compacting"`.
 * - **Codex**: mapped from an `item/started` notification whose item
 *   `type:"contextCompaction"`.
 */
export interface AgentCompactionStartedEvent {
  type: "agent_compaction_started";
  /**
   * `"manual"` when ShipIt asked for the compaction (`/compact`), `"auto"` when
   * the CLI compacted on its own. Optional: Codex emits no manual/auto field, so
   * the adapter labels it by correlation (whether ShipIt sent the trigger) and
   * leaves it undefined when it can't tell.
   */
  trigger?: "manual" | "auto";
}

/**
 * docs/178 — a context compaction *finished*. This is transcript content (the
 * conversation history was replaced by a summary), so the orchestrator persists
 * it as an inline card via `emitChatCard`, not emit-only. Every detail field is
 * optional because Codex supplies none of them natively — the card degrades to a
 * bare "Context compacted" row when they're absent.
 *
 * - **Claude**: mapped from the CLI's `system`/`subtype:"compact_boundary"`
 *   event, whose `compact_metadata` carries `{trigger, pre_tokens, post_tokens,
 *   duration_ms}`.
 * - **Codex**: mapped from an `item/completed` notification whose item
 *   `type:"contextCompaction"`, with token figures pulled from the adjacent
 *   `thread/tokenUsage/updated` snapshot.
 */
export interface AgentCompactedEvent {
  type: "agent_compacted";
  /** See {@link AgentCompactionStartedEvent.trigger}. */
  trigger?: "manual" | "auto";
  /** Context-window occupancy (tokens) before compaction. */
  preTokens?: number;
  /** Context-window occupancy (tokens) after compaction. */
  postTokens?: number;
  /** How long the compaction took, in ms, when the backend reports it. */
  durationMs?: number;
}

/**
 * SHI-112 / docs/193 — an agent backend is asking the user to approve a gated
 * action (a sensitive-file edit, an escalated command, …) that the backend
 * cannot auto-approve in ShipIt's headless model. This is the agent-agnostic
 * canonical shape: the worker's `PermissionBroker` broadcasts it (wrapped in an
 * `agent_event` SSE frame) the moment a request is registered, regardless of
 * which adapter produced it:
 *
 * - **Claude** routes its built-in sensitive-file gate to ShipIt's
 *   `--permission-prompt-tool` (the `shipit` bridge's permission tool,
 *   `mcp-tools/permission.ts`), which POSTs the request to the worker.
 * - **Codex** routes the app-server's blocking approval requests
 *   (`item/.../requestApproval`) through the same broker instead of
 *   auto-accepting them.
 *
 * The orchestrator renders + persists a `permission_request_card` from this
 * event; the user's approve/deny(+remember) answer flows back as a
 * `resolve_permission` WS message → `resolvePermission` → the broker, which
 * unblocks the held bridge/RPC call. The turn stays alive while the request is
 * pending (the CLI/app-server is blocked inside the tool call), so — unlike
 * AskUserQuestion — no interrupt/resume is needed.
 */
export interface AgentPermissionRequestEvent {
  type: "agent_permission_request";
  /** Stable id correlating the request, the rendered card, and the resolution. */
  requestId: string;
  /** The tool the agent tried to use (e.g. "Write", "Edit", "Bash", "apply_patch"). */
  toolName: string;
  /** The file path / resource the gate fired on, when one can be extracted from the tool input. */
  path?: string;
  /** One-line human description of what is being requested (shown on the card). */
  summary?: string;
  /** Which agent produced it (display only). */
  agentId?: AgentId;
}

/**
 * docs/193 — the terminal transition for a permission request, broadcast by the
 * broker when the user answers it (the only thing that settles a request), so
 * the orchestrator patches the persisted card to its terminal state
 * idempotently by `requestId`. There is no timeout/expiry transition — an
 * unanswered request simply stays pending; ShipIt imposes no deadline.
 */
export interface AgentPermissionResolvedEvent {
  type: "agent_permission_resolved";
  requestId: string;
  behavior: "allow" | "deny";
  /** True when the user asked to remember the decision for this path this session. */
  remembered?: boolean;
}

/**
 * docs/193 — the user's answer to a permission request. Travels from the client
 * (`resolve_permission` WS message) down to the worker's broker, which maps it
 * to each backend's native response: Claude's `--permission-prompt-tool`
 * envelope (`{behavior:"allow",updatedInput}` / `{behavior:"deny",message}`),
 * Codex's approval `{decision:"accept"|"reject"}`.
 */
export interface PermissionDecision {
  behavior: "allow" | "deny";
  /** Remember an `allow` for this path for the rest of the session (skip re-prompting). */
  remember?: boolean;
  /** Optional message surfaced to the agent on `deny`. */
  message?: string;
}

/** The fields a backend supplies to open a permission request via the broker. */
export interface PermissionRequestInput {
  /** The tool the agent tried to use (e.g. "Write", "Edit", "Bash", "apply_patch"). */
  toolName: string;
  /** The raw tool input, used to derive a resource path + summary when not given. */
  input?: Record<string, unknown>;
  /** Explicit resource path. When omitted, derived from `input`. */
  path?: string;
  /** Explicit one-line summary. When omitted, derived from toolName + path. */
  summary?: string;
  /** Which agent raised it (display only). */
  agentId?: AgentId;
  /**
   * The gated tool call's id. Used as the broker's idempotency key (docs/193,
   * Thread B): a retried/duplicated open for the same call re-attaches to the
   * one pending card instead of stacking another. Codex doesn't supply it (its
   * approval RPC is one-shot, not retried), so it stays optional.
   */
  toolUseId?: string;
}

/**
 * docs/193 — the worker injects this into adapters that surface gated actions
 * through a native blocking channel (Codex's app-server approval requests). The
 * adapter calls it to open a user-answerable approve/deny card and blocks on the
 * returned decision. Bound to the worker's `PermissionBroker.request`. Claude
 * doesn't use it (its requests arrive via the `--permission-prompt-tool` MCP
 * bridge, out of band of the adapter).
 */
export type PermissionRequester = (input: PermissionRequestInput) => Promise<PermissionDecision>;

export type AgentEvent =
  | AgentInitEvent
  | AgentAssistantEvent
  | AgentToolResultEvent
  | AgentResultEvent
  | AgentRateLimitsEvent
  | AgentSteerRejectedEvent
  | AgentUserReplayEvent
  | AgentCompactionStartedEvent
  | AgentCompactedEvent
  | AgentPermissionRequestEvent
  | AgentPermissionResolvedEvent;

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
   * Reasoning/effort level for this run, an agent-specific token from the
   * agent's `reasoning.options` (Claude: low…max via `--effort`; Codex:
   * none…xhigh via `model_reasoning_effort`). Undefined = pass no flag (the
   * CLI's native default). See docs/217-per-agent-reasoning.
   */
  reasoningEffort?: string;
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
   * docs/211 — when true this is a Sandbox session: the Claude adapter sets
   * SHIPIT_SANDBOX=1 in the CLI environment so the managed-settings.json
   * PreToolUse branch-block hook self-gates off (a sandbox owns its own branches
   * across cloned repos). Claude-only; other adapters ignore it.
   */
  sandbox?: boolean;
  /**
   * When true, the Claude adapter spawns with --input-format stream-json
   * for live steering. Ignored by non-streaming adapters. (docs/140)
   */
  useStreaming?: boolean;
  /**
   * docs/178 — this run is a context-compaction request, not a normal prompt.
   * The orchestrator sets this when intercepting `/compact` and no resident
   * live process exists to call `compact()` on. Adapters honor it at spawn:
   * Claude treats the `/compact` prompt as the CLI slash command (no special
   * branch needed); Codex resumes the thread and issues `thread/compact/start`
   * instead of a normal `turn/start`. Ignored by adapters whose `/compact` rides
   * the normal prompt path.
   */
  compact?: boolean;
}

// ---- Per-agent MCP config writer (docs/155 hair 10) ----

/**
 * Resolved launch paths for the consolidated internal MCP bridge
 * (SHI-128 / docs/199). The worker resolves this ONCE (`resolveBridge`,
 * preferring the precompiled bundle over tsx-on-source) and hands it to the
 * adapter, which writes a single `shipit` MCP server entry. The set of tools
 * that server exposes is selected per agent via the `SHIPIT_MCP_TOOLS` env, not
 * via separate bridges — Claude gets review/present/voice/bug/permission, Codex
 * gets review/present/voice/ask/bug. `tsxBin` is the spawn command (the `node`
 * binary for the compiled bundle, or `tsx` for `.ts` source); the field keeps
 * its historical name. The whole bridge is omitted when null (stripped-down test
 * image) so agent start never fails on it.
 */
export interface AgentMcpBridge {
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
   * The consolidated internal MCP bridge (SHI-128 / docs/199), or `null` when
   * the worker can't locate the bridge files (stripped-down test image). Each
   * adapter writes a single `shipit` MCP server entry pointing at it and selects
   * the tools to expose via the `SHIPIT_MCP_TOOLS` env (Claude:
   * review/present/voice/bug/permission; Codex: review/present/voice/ask/bug).
   * When null the adapter omits the entry rather than failing agent start.
   */
  shipitBridge: AgentMcpBridge | null;
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
   * docs/178 — trigger a context compaction on the *resident* process. Optional,
   * gated by `capabilities.supportsCompaction`. Used by the `/compact`
   * interception when a live turn is in flight (a streaming Claude process or a
   * live Codex app-server with a thread): Claude injects the `/compact` slash
   * command via `sendUserMessage`; Codex sends the `thread/compact/start` RPC.
   * When no live process is resident the orchestrator spawns a fresh compaction
   * turn via `run({ compact: true })` instead, so adapters may treat this as a
   * best-effort no-op when there's nothing to talk to.
   *
   * `instructions` is the optional custom-compaction text from `/compact <args>`
   * — Claude appends it to the slash command (`/compact <args>`), which its CLI
   * honors; Codex's `thread/compact/start` RPC has no instruction parameter, so
   * it ignores them.
   */
  compact?(instructions?: string): void;
  /**
   * docs/193 — deliver the user's approve/deny answer for a pending permission
   * request to the backend. Optional: only meaningful for adapters whose run
   * surfaces gated actions through the worker's `PermissionBroker` (Claude via
   * `--permission-prompt-tool`, Codex via its app-server approval channel). The
   * orchestrator-side `ProxyAgentProcess` forwards it to the worker's
   * `/agent/permission/resolve` endpoint, where the broker unblocks the held
   * bridge/RPC call. Implemented by `ProxyAgentProcess` (the orchestrator-side
   * stand-in for the in-container agent); adapters without a permission channel
   * may omit it.
   */
  resolvePermission?(requestId: string, decision: PermissionDecision): void;
  /**
   * docs/193 — accept the worker's `PermissionBroker.request` so the adapter can
   * route its backend's native blocking approval requests through the shared
   * approve/deny card instead of auto-deciding. Injected by the worker right
   * after construction. Optional: only adapters with such a channel (Codex)
   * implement it; Claude's gate is bridged via `--permission-prompt-tool`.
   */
  setPermissionRequester?(requester: PermissionRequester): void;
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
