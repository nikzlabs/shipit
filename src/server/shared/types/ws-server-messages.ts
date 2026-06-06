import type { AgentId, AgentEvent } from "./agent-types.js";
import type { PermissionMode } from "./attachment-types.js";
import type { GitCommitInfo, SessionInfo, DocEntry, FileTreeNode, FileDiff, RepoInfo, SecretRequirement, FileReview, WsChatHistoryMessage, IssueWriteCard, IssueWriteUndoState, CompactionCard } from "./domain-types.js";
import type {
  WsGitHubStatus,
  WsGitHubPushResult,
  WsGitHubRemotes,
  WsGitHubBranches,
  WsGitHubSearchResults,
  WsPrStatus,
  WsPrLifecycleUpdate,
} from "./github-types.js";
import type { WsTerminalOutput, WsTerminalExit, WsTerminalReconnecting, WsLogEntry, WsClearLogs } from "./terminal-types.js";
import type { WsUsageStats, WsUsageUpdate, WsTurnUsageUpdate } from "./usage-types.js";
import type { SubscriptionLimitsMap } from "./usage-limits-types.js";
import type { VoiceNoteSource } from "./voice-note-types.js";

export interface WsAgentEvent {
  type: "agent_event";
  event: AgentEvent;
}

export interface WsError {
  type: "error";
  message: string;
}

export interface WsPreviewStatus {
  type: "preview_status";
  running: boolean;
  port: number;
  url: string;
  /** How the preview server was identified: "vite" (bundled), "managed" (command mode), "detected" (port scan), or omitted. */
  source?: "vite" | "managed" | "detected";
  /** All ports detected by the port scanner (non-Vite dev servers). */
  detectedPorts?: number[];
  /** Non-null when the preview server crashed. Contains the process exit code. */
  exitCode?: number | null;
  /** Last lines of preview output captured before the crash. */
  errorOutput?: string;
  /** Session that owns this preview — client discards stale messages during session switching. */
  sessionId?: string;
}

export interface WsGitLog {
  type: "git_log";
  commits: GitCommitInfo[];
}

export interface WsGitCommitted {
  type: "git_committed";
  hash: string;
  message: string;
}

// ---- Auth types ----

/**
 * Per-session WS message: the agent CLI signalled `auth_required` during a
 * turn, so the orchestrator killed the turn and is kicking off the
 * appropriate auth flow. Stops the turn spinner on the client; the
 * follow-up `agent_auth_pending` SSE event carries the actual sign-in URL.
 *
 * Distinct from the SSE `agent_auth_pending` family below — this one is
 * scoped to the failing session, not broadcast app-wide.
 */
export interface WsAuthRequired {
  type: "auth_required";
}

/**
 * Discriminated payload for {@link WsAgentAuthPending}. Each backend's auth
 * flow surfaces different information to the user, so the union is the
 * shared shape: lifting it into a flat record would either pad it with
 * unused fields or fall back to `unknown`.
 *
 *   - `code-paste-url`: Claude OAuth — the user visits the URL, then pastes
 *     the resulting code back into the sign-in card.
 *   - `device-code`: Codex `--device-auth` / RFC 8628 — the user visits the
 *     URL and types the short user code into auth.openai.com; the CLI polls
 *     the auth server until the user approves.
 *
 * Adding a backend with a third flow (e.g. an API-key paste) is one new
 * variant here plus a matching branch in the sign-in card.
 */
export type AgentAuthPendingDetails =
  | {
      kind: "code-paste-url";
      /** URL the user opens to authorize; on return, they paste a code into the sign-in card. */
      verificationUri: string;
    }
  | {
      kind: "device-code";
      /** Verification URL printed by the CLI (`https://auth.openai.com/codex/device`). */
      verificationUri: string;
      /** Short code the user types into the verification page (`XXXX-XXXXX`). */
      userCode: string;
      /** Device-code TTL in seconds. */
      expiresInSec: number;
    };

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow has produced its
 * pending state and is waiting on the user. Adding a new backend means
 * emitting this event from its `AgentAuthManager` — the client's single
 * handler dispatches on `agentId` + `details.kind`. (docs/155 Phase 2b)
 */
export interface WsAgentAuthPending {
  type: "agent_auth_pending";
  agentId: AgentId;
  /**
   * Provider-account id this flow authenticates (docs/150). Present when the
   * flow was started for a specific stored account row; omitted for the
   * legacy singleton flow. The client uses it to attach the pending state to
   * the matching Settings account row.
   */
  accountId?: string;
  details: AgentAuthPendingDetails;
}

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow completed
 * successfully. Receivers refresh the agent list — `authConfigured` for the
 * named agent flips to `true`. (docs/155 Phase 2b)
 */
export interface WsAgentAuthComplete {
  type: "agent_auth_complete";
  agentId: AgentId;
  /** Provider-account id that just authenticated (docs/150), when scoped. */
  accountId?: string;
}

/**
 * Server → Client (SSE-broadcast): a per-agent auth flow failed or the
 * persisted credentials were revoked. `reason` lets the UI tailor the next
 * step (retry on `timeout`/`denied`/`error`, prompt re-sign-in on
 * `revoked`). (docs/155 Phase 2b)
 */
export interface WsAgentAuthFailed {
  type: "agent_auth_failed";
  agentId: AgentId;
  /** Provider-account id whose flow failed (docs/150), when scoped. */
  accountId?: string;
  reason?: "timeout" | "denied" | "error" | "revoked";
  message?: string;
}

export interface WsSessionList {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface WsSessionStarted {
  type: "session_started";
  session: SessionInfo;
}

export interface WsSessionRenamed {
  type: "session_renamed";
  session: SessionInfo;
}

export interface WsDocList {
  type: "doc_list";
  docs: DocEntry[];
}

export interface WsDocContent {
  type: "doc_content";
  path: string;
  content: string;
}

export interface WsFileTree {
  type: "file_tree";
  tree: FileTreeNode[];
}

export interface WsFileContent {
  type: "file_content";
  path: string;
  content: string;
  /** When true, the file is binary and `content` contains a human-readable message instead of file data. */
  isBinary?: boolean;
}

// ---- File watcher types ----

export interface WsFilesChanged {
  type: "files_changed";
  /** Relative paths of files that changed in the workspace. */
  paths: string[];
}

// ---- Git identity messages ----

export interface WsGitIdentityRequired {
  type: "git_identity_required";
}

export interface WsGitIdentitySet {
  type: "git_identity_set";
  name: string;
  email: string;
}

// ---- Global settings messages ----

/** Bundled response containing all global settings. */
export interface WsGlobalSettings {
  type: "global_settings";
  gitIdentity: { name: string; email: string };
  systemPrompt: string;
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
    /**
     * Whether the agent backend can run the chat-native AI review flow
     * (docs/125-chat-native-ai-review). Drives whether the "Ask agent to
     * review" button shows up in the file-preview modal.
     */
    supportsReview: boolean;
    /**
     * Whether this agent supports live steering (docs/140) — injecting user
     * messages into a running turn without queuing.
     */
    supportsSteering: boolean;
    /**
     * Permission modes this agent supports (docs/138). Drives the client's
     * agent-aware mode selector — e.g. `guarded` is only offered when this
     * array includes it. Codex reports `[]` (no permission modes).
     */
    supportedPermissionModes: PermissionMode[];
  }[];
  /** When true, mid-turn messages steer the running agent. (docs/140) */
  liveSteering: boolean;
  /** docs/146 — global gate for the auto-resolve-conflicts loop. */
  autoResolveConflicts?: boolean;
  /** docs/169 — global gate for the auto-fix-CI loop. */
  autoFixCi?: boolean;
}

// ---- Template messages ----

export interface WsTemplateApplied {
  type: "template_applied";
  templateId: string;
  name: string;
}

// ---- Model info ----

/** Sent once after the Claude CLI init event, and on reconnect. */
export interface WsModelInfo {
  type: "model_info";
  model: string;
  contextWindowTokens: number;
}

// ---- Prompt queuing messages ----

/** Server → Client: a message was queued because Claude is busy. */
export interface WsMessageQueued {
  type: "message_queued";
  /** 1-indexed display position in the queue. */
  position: number;
  text: string;
}

/** Server → Client: the queue changed (after a cancel, dequeue, or session switch). */
export interface WsQueueUpdated {
  type: "queue_updated";
  /** Current queue contents after the change. */
  queue: { text: string; position: number }[];
  /** Text of the message that was just dequeued for execution (absent on cancel/clear). */
  dequeued?: string;
}

/**
 * Server → Client: a user message was steered to the running agent (live
 * steering active). The message was injected mid-turn rather than queued.
 * (docs/140)
 */
export interface WsMessageSteered {
  type: "message_steered";
  text: string;
  sessionId: string;
  /**
   * Attachments the user sent with the steer. Same shapes that chat history
   * persists for user messages — so reconnecting viewers / other tabs render
   * the steered bubble identically to a reloaded one.
   */
  images?: { data: string; mediaType: string }[];
  files?: { path: string; contentPreview: string; startLine?: number; endLine?: number }[];
  uploadPaths?: string[];
}

// ---- Diff review messages (server → client) ----

export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

// ---- Subscription limits ----

/**
 * Server → Client (SSE only): account-wide subscription rate-limit
 * snapshots per agent. Sent on `/api/events` initial connect and
 * whenever any provider's snapshot changes (success → success delta,
 * success → error transition, sign-out → key removed).
 *
 * The payload is a complete map — providers missing from `limits`
 * have either no provider registered, `canFetch() === false`, or have
 * been signed out. The client replaces its store map wholesale.
 *
 * See docs/135-subscription-limits-badge/plan.md.
 */
export interface WsSubscriptionLimits {
  type: "subscription_limits";
  limits: SubscriptionLimitsMap;
}

// ---- Agent registry server messages ----

export interface WsAgentListMessage {
  type: "agent_list";
  agents: {
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
    /**
     * Whether the agent backend can run the chat-native AI review flow
     * (docs/125-chat-native-ai-review). Drives whether the "Ask agent to
     * review" button shows up in the file-preview modal.
     */
    supportsReview: boolean;
    /**
     * Whether this agent supports live steering (docs/140) — injecting user
     * messages into a running turn without queuing.
     */
    supportsSteering: boolean;
    /**
     * Permission modes this agent supports (docs/138). Drives the client's
     * agent-aware mode selector — e.g. `guarded` is only offered when this
     * array includes it. Codex reports `[]` (no permission modes).
     */
    supportedPermissionModes: PermissionMode[];
  }[];
}

/** Server → Client: the agent was interrupted by user. */
export interface WsAgentInterrupted {
  type: "agent_interrupted";
}

/**
 * Server → Client: progress update for a Rescue session ("Restart container")
 * operation.
 *
 * Emitted as the operation moves through phases inside
 * `POST /api/sessions/:id/container/restart`. The client renders a phased
 * overlay so the user can see *which* step is in flight and, when something
 * goes wrong, *where* the operation failed (rather than an opaque spinner
 * timing out).
 *
 * See docs/124-session-rescue-and-diagnostics §3.2.
 */
export type RescuePhase =
  | "stopping_stack"
  | "destroying_container"
  | "creating_container"
  | "starting_stack"
  /**
   * `restarting_agent` is emitted by the `restartAgent` recovery flow
   * (POST /api/sessions/:id/agent/container/restart). It's a single
   * cosmetic phase wrapping destroy+recreate of the agent container while
   * leaving the compose stack running. The client renders "Restarting
   * agent…" instead of the full Rescue phase sequence. See
   * docs/127-restart-agent.
   */
  | "restarting_agent"
  | "ready"
  | "failed";

export interface WsContainerRestarting {
  type: "container_restarting";
  sessionId: string;
  /**
   * Current phase. Older clients ignore this; newer ones render a
   * step-by-step overlay. Absent on a final `ready`/`failed` re-broadcast
   * is treated as the legacy single-event payload.
   */
  phase?: RescuePhase;
  /** When `phase === "failed"`, the underlying reason (e.g. "destroy_timeout"). */
  reason?: string;
  /** Human-readable detail to render under the phase label. */
  message?: string;
}

/** Server → Client: full reset completed successfully. */
export interface WsFullResetComplete {
  type: "full_reset_complete";
}


// ---- Install status messages (server → client) ----

/** Server → Client: status update for agent.install execution. */
export interface WsInstallStatus {
  type: "install_status";
  sessionId: string;
  status: "running" | "complete" | "error" | "skipped";
  /** Current command being executed. */
  command?: string;
  /** Error message on failure. */
  message?: string;
}

/**
 * Server → Client: per-MCP-server runtime status (docs/088-mcp-integration).
 * Originates as a worker SSE `mcp_server_status` event and is relayed to the
 * browser so the Settings → MCP Servers panel can render load state.
 */
export interface WsMcpServerStatus {
  type: "mcp_server_status";
  sessionId: string;
  /** Server name (the `mcp__<name>__*` namespace identifier). */
  name: string;
  state: "loaded" | "failed" | "crashed" | "disabled";
  /** Human-readable reason when `state` is "failed" or "crashed". */
  reason?: string;
}

/** Server → Client: log output from agent.install execution. */
export interface WsInstallLog {
  type: "install_log";
  sessionId: string;
  text: string;
  stream: "stdout" | "stderr";
}

// ---- Compose service messages (server → client) ----

export type ComposeServiceStatus = "stopped" | "starting" | "running" | "error";
export type ComposeServicePreviewMode = "auto" | "manual";

/** Server → Client: status update for a single compose service. */
export interface WsServiceStatus {
  type: "service_status";
  sessionId: string;
  name: string;
  status: ComposeServiceStatus;
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;
}

/** Server → Client: full list of compose services for a session. */
export interface WsServiceList {
  type: "service_list";
  sessionId: string;
  services: {
    name: string;
    status: ComposeServiceStatus;
    port?: number;
    preview: ComposeServicePreviewMode;
    error?: string;
  }[];
}

/** Server → Client: log output from a compose service. */
export interface WsServiceLog {
  type: "service_log";
  sessionId: string;
  name: string;
  text: string;
}

/** Server → Client: buffered log replay for a compose service. */
export interface WsServiceLogBuffer {
  type: "service_log_buffer";
  sessionId: string;
  name: string;
  buffer: string;
}

// ---- Rebase messages (server → client) ----

/** Server → Client: git push was rejected due to non-fast-forward (branch has diverged). */
export interface WsGitPushRejected {
  type: "git_push_rejected";
  reason: "non_fast_forward";
  message: string;
}

/** Server → Client: rebase has started. */
export interface WsRebaseStarted {
  type: "rebase_started";
  baseBranch: string;
}

/** Server → Client: rebase encountered conflicts. */
export interface WsRebaseConflicts {
  type: "rebase_conflicts";
  conflicts: { path: string }[];
}

/** Server → Client: rebase completed successfully. */
export interface WsRebaseComplete {
  type: "rebase_complete";
  forcePushed: boolean;
  /**
   * Set when the branch already contained every commit from the base branch,
   * so no rebase ran (the ancestry short-circuit in `runRebaseFlow`). Lets the
   * client confirm a no-op "Sync with main" click — otherwise a manual sync
   * that had nothing to do would flash the banner and vanish silently.
   */
  upToDate?: boolean;
}

/** Server → Client: rebase was aborted. */
export interface WsRebaseAborted {
  type: "rebase_aborted";
  /**
   * Set when the abort was caused by a server-side failure (e.g. fetch
   * error, unresolvable base ref, non-conflict git rebase failure, runner
   * busy). Absent for user-initiated aborts via the `/rebase/abort`
   * endpoint, where reaching idle is the intended outcome.
   */
  reason?: string;
}

/**
 * Server → Client: an auto-resolve-conflicts attempt has started. (docs/146)
 *
 * Fires from the rebase-driver wrapper at the top of an attempt. The inner
 * `rebase_started` / `rebase_conflicts` / `rebase_complete` events still fire
 * from `runRebaseFlow` as a side effect — this envelope is the outer
 * attempt-loop signal carrying `attempt` (only meaningful in the retry
 * context).
 */
export interface WsAutoResolveStarted {
  type: "auto_resolve_started";
  sessionId: string;
  baseBranch: string;
  /** 1-indexed attempt number. Pairs with the same field on WsAutoResolveResult. */
  attempt: number;
}

/**
 * Server → Client: an auto-resolve-conflicts attempt has settled. (docs/146)
 *
 * `success`, `error`, and `deferred` are per-attempt outcomes. `exhausted` is
 * the manager-emitted terminal envelope (cap reached) and is the only outcome
 * the failure banner renders.
 */
export interface WsAutoResolveResult {
  type: "auto_resolve_result";
  sessionId: string;
  outcome: "success" | "exhausted" | "deferred" | "error";
  /** 1-indexed; matches the `attempt` field on the prior WsAutoResolveStarted for the same attempt. */
  attempt: number;
  /**
   * Only meaningful when outcome === "success". Mirrors WsRebaseComplete.forcePushed
   * so the PR-card sub-banner can optionally show "rebased locally, push deferred"
   * without listening to two channels.
   */
  forcePushed?: boolean;
  /** Failure / defer reason. Required when outcome === "exhausted" — the failure banner needs it. */
  lastError?: string;
}

/** Server → Client: Docker Compose stack failed to start. */
export interface WsComposeError {
  type: "compose_error";
  sessionId: string;
  message: string;
}

/**
 * Server → Client: a stack-level emergency from `ServiceManager`.
 *
 * Distinct from `compose_error` (user-facing PreviewFrame banner emitted
 * from the startup catch path) — this carries any error the manager
 * raises via its `stack_error` EventEmitter signal. Today it fires only
 * on startup, so the two channels overlap; the separate type means
 * future non-startup emit sites (e.g. a mid-session `compose down`
 * failure) reach the client without re-wiring.
 *
 * The diagnostics panel reads recent `stack_error` log-ring entries so
 * a viewer that connects after the fact still sees the failure.
 *
 * See docs/124-session-rescue-and-diagnostics §1.1.
 */
export interface WsStackError {
  type: "stack_error";
  sessionId: string;
  message: string;
}

/** Server → Client: No compose file configured in shipit.yaml. */
export interface WsComposeNotConfigured {
  type: "compose_not_configured";
  sessionId: string;
}

/**
 * Server → Client: declared secrets and missing-required report for a session.
 *
 * Emitted whenever `ServiceManager.syncSecrets()` runs (compose start,
 * reconcile, secret save). The client uses this to:
 *   - Show a "Configure secrets to run this project" banner in the preview
 *     panel when `missingRequired.length > 0`.
 *   - Render the secrets panel with declared-vs-undeclared distinction and
 *     show per-secret descriptions, required indicators, and consumer
 *     service chips.
 *
 * `missingByService` includes both required and optional missing values;
 * `missingRequired` is the union of just the required-and-missing names.
 * The banner only fires on `missingRequired`.
 */
export interface WsSecretsStatus {
  type: "secrets_status";
  sessionId: string;
  /** All declared secrets across all services, de-duplicated by name. */
  declared: (SecretRequirement & { services: string[] })[];
  /** Service name → secret names declared but not present (required + optional). */
  missingByService: Record<string, string[]>;
  /**
   * De-duplicated list of names whose `required: true` flag is set but no
   * value was found. Empty list = no banner.
   */
  missingRequired: string[];
}

// ---- Session runner messages (server → client) ----

/** Server → Client: current runtime state of a session. */
export interface WsSessionStatus {
  type: "session_status";
  sessionId: string;
  running: boolean;
  queueLength?: number;
  /** Present when the session encountered a fatal error (e.g. container crash). */
  error?: string;
  /**
   * Optional explanation for a notable state transition. Lets the client
   * surface a non-error inline notice ("Session paused after N minutes
   * idle. Send a message to resume.") instead of leaving the user to
   * guess why their container went away.
   *
   * - `idle-disposed` — idle enforcer reaped the container after the grace
   *   period elapsed.
   * - `memory-pressure` — pressure-aware eviction reaped the container
   *   (feature 122).
   * See docs/124-session-rescue-and-diagnostics §1.6.
   */
  reason?: "idle-disposed" | "memory-pressure";
  /** When `reason` is set, how long the session was idle before disposal (ms). */
  idleMs?: number;
  /**
   * Most recent failure from a best-effort `agent/kill` call (Interrupt or
   * Rescue session). Non-fatal — the kill is best-effort by design — but
   * useful when the worker is wedged and the user wonders why the button
   * "did nothing." Renders as a non-blocking toast on the client.
   *
   * See docs/124-session-rescue-and-diagnostics §1.4.
   */
  lastInterruptError?: string;
}

/**
 * Server → Client: the per-session preview proxy could not reach the
 * compose-managed container on the requested port (connection refused,
 * EHOSTUNREACH, HMR upgrade socket destroyed, etc).
 *
 * Today, proxy errors only manifest as a 502 JSON body inside the iframe
 * or an empty WebSocket disconnect — neither of which is observable from
 * the orchestrator's side and neither of which gives the user actionable
 * feedback. This message lets the PreviewFrame overlay an explicit
 * banner and routes a record into the Logs panel.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
export interface WsPreviewError {
  type: "preview_error";
  sessionId: string;
  /** Port the proxy was attempting to reach. */
  port: number;
  /** Short human-readable reason (e.g. "Connection refused", "HMR upgrade failed"). */
  message: string;
  /** Whether the failure was on the WebSocket-upgrade path (HMR) or plain HTTP. */
  upgrade?: boolean;
}

/**
 * Server → Client: a Compose-managed (i.e. user) container was OOM-killed.
 *
 * The Docker event loop in `container-health.ts` historically only watched
 * containers labeled `shipit-session=true`, which excludes compose
 * children (which carry `shipit-parent-session={sid}` instead). The
 * widened filter now catches compose-child OOMs and emits this event so
 * the user gets an immediate "service was killed for OOM" notice instead
 * of waiting 5 s for `pollStatus` to flip the service to `error` with the
 * unhelpful "Exited with code 137" message.
 *
 * See docs/124-session-rescue-and-diagnostics §1.2.
 */
export interface WsServiceOom {
  type: "service_oom";
  sessionId: string;
  /** Compose service name, when resolvable. */
  serviceName?: string;
  /** Underlying Docker container id (short form). */
  containerId: string;
}

/**
 * Server → Client: the OOM circuit breaker tripped for this session.
 *
 * Fired once when the breaker flips from healthy to tripped — i.e. the
 * Nth agent-container OOM kill within the rolling window. Future
 * container creations for this session will be refused (with a clear
 * error in the SessionHealthStrip) until the user explicitly opts back
 * in via the "Rescue session" / agent-container-restart endpoint, which
 * resets the breaker.
 *
 * Note: this is the *agent* container OOM, not a compose-child OOM
 * (which still uses `service_oom`). The two events are intentionally
 * distinct — a service OOM is recoverable, an agent-container OOM kills
 * the agent and triggers the destroy/recreate loop this breaker exists
 * to short-circuit.
 */
export interface WsSessionMemoryExhausted {
  type: "session_memory_exhausted";
  sessionId: string;
  /** OOM kills counted in the rolling window when the breaker tripped. */
  countInWindow: number;
  /** Rolling-window length in ms (informational, for UI copy). */
  windowMs: number;
  /** Threshold the breaker tripped at (informational, for UI copy). */
  threshold: number;
}

/** Server → Client: agent started running in a session (broadcast to all clients). */
export interface WsSessionAgentStarted {
  type: "session_agent_started";
  sessionId: string;
  /** Optional activity label for system-initiated turns (e.g. "Auto-fixing CI..."). */
  activity?: string;
}

/** Server → Client: agent finished in a session (broadcast to all clients). */
export interface WsSessionAgentFinished {
  type: "session_agent_finished";
  sessionId: string;
}

// ---- Repo messages (server → client) ----

/** Server → Client: repo clone status changed. */
export interface WsRepoStatus {
  type: "repo_status";
  url: string;
  status: "cloning" | "ready";
}

/** Server → Client: a warm session is ready for a repo. */
export interface WsRepoWarmReady {
  type: "repo_warm_ready";
  url: string;
  sessionId: string;
}

/** Server → Client: full repo list update. */
export interface WsRepoList {
  type: "repo_list";
  repos: RepoInfo[];
}

/** Server → Client: a server-initiated user message (e.g. CI fix prompt). */
export interface WsSystemUserMessage {
  type: "system_user_message";
  text: string;
  /** Activity label for the UI (e.g. "Auto-fixing CI..."). */
  activity?: string;
}

/**
 * Server → Client: an informational system note rendered inline in the chat
 * (docs/138). Distinct from `error` — it does NOT clear the loading state, so
 * it can be emitted mid-turn (e.g. "guarded mode unavailable, continuing in
 * auto") as well as post-turn (e.g. a summary of classifier-blocked actions).
 * Broadcast via `runner.emitMessage()` so every viewer sees it and it lands in
 * the turn-event buffer for reconnecting viewers.
 */
export interface WsSystemNotice {
  type: "system_notice";
  sessionId: string;
  message: string;
  /** Visual emphasis. `warn` for blocked-action / abort notices; `info` otherwise. */
  level?: "info" | "warn";
}

// ---- Rollback messages (server → client) ----

/** Server → Client: a commit was linked to an assistant message. */
export interface WsCommitLinked {
  type: "commit_linked";
  messageIndex: number;
  commitHash: string;
  parentCommitHash: string;
}

/** Server → Client: rewind completed — remove messages after the rewind point. */
export type WsRewindComplete =
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "chat";
      droppedMessageCount: number;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    }
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "code";
      commitHash: string;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    }
  | {
      type: "rewind_complete";
      gapPosition: number;
      action: "both";
      droppedMessageCount: number;
      /** Omitted when the session had no auto-commits and "both" degraded to chat-only. */
      commitHash?: string;
      snapshotSessionId?: string;
      snapshotExpiresAt?: number;
    };

export interface WsRewindSnapshotAvailable {
  type: "rewind_snapshot_available";
  sessionId: string;
  action: "chat" | "code" | "both" | "fork";
  expiresAt: number;
}

export interface WsRewindRestored {
  type: "rewind_restored";
  sessionId: string;
  action: "chat" | "code" | "both" | "fork";
  archivedSessionId?: string;
}

export interface WsRewindPreview {
  type: "rewind_preview";
  gapPosition: number;
  action: "chat" | "code" | "both" | "fork";
  discardedTurnGroupCount?: number;
  keptTurnGroupCount?: number;
  fileCount?: number;
}

/** Server → Client: a new session was forked from a rollback point. */
export interface WsSessionForked {
  type: "session_forked";
  parentSessionId: string;
  childSessionId: string;
  title: string;
  branch: string;
  snapshotSessionId?: string;
  snapshotExpiresAt?: number;
  sessionId?: string;
  sessionName?: string;
}

export interface WsForkBreadcrumb {
  type: "fork_breadcrumb";
  parentSessionId: string;
  message: WsChatHistoryMessage;
}

/**
 * Server → Client: the parent agent successfully spawned a sibling session
 * via the `shipit session create` shim (docs/117 Phase 2).
 *
 * Emitted on the *parent's* runner via `runner.emitMessage(...)` so every
 * attached viewer sees it and it lands in the turn-event buffer for
 * reconnecting viewers. The client renders a `SpawnedSessionCard` inline in
 * the parent's chat — title, branch, status pill, and an "Open" button that
 * switches the active session to the child.
 *
 * The child session itself shows up in the user's sidebar via the existing
 * `session_list` SSE broadcast that the spawn route already emits; this
 * event is purely the chat-side affordance.
 */
export interface WsSessionSpawned {
  type: "session_spawned";
  /** Parent session id — the runner that this event is emitted on. */
  sessionId: string;
  /** The newly-created child session's id. */
  childSessionId: string;
  /** Child session title (matches the sidebar row). */
  title: string;
  /** Branch the child was cut on (matches the sidebar row's branch). */
  branch?: string;
  /** ISO8601 timestamp the child was created at. */
  spawnedAt: string;
  /**
   * docs/162 — present only for Ops `--shipit-source` fix-session spawns. When
   * set, the client renders the spawned-session card in its "ShipIt fix"
   * variant: the exact commit the child branched from, the target repo the fix
   * PR opens against, and a short diagnosis summary. Absent for ordinary
   * same-repo fan-out spawns (which render the plain card).
   */
  shipitFix?: {
    /** Commit the child was branched from (the inspected source ref). */
    sourceRef: string;
    /** True only when `sourceRef` is the exact deployed build commit. */
    sourceExact: boolean;
    /** Where `sourceRef` came from — exact build id vs. checkout HEAD. */
    refSource?: "build-id" | "checkout-head";
    /** `owner/repo` the fix PR will open against. */
    targetRepo?: string;
    /** First line of the Ops diagnosis, truncated, for the card. */
    diagnosis?: string;
  };
}

/**
 * Server → Client: the parent agent's `shipit session create` invocation
 * was rejected by the orchestrator (docs/117 cross-cutting follow-up).
 *
 * Counterpart to `WsSessionSpawned` for the failure path. Without this, a
 * spawn rejection (quota hit, archived parent, bad payload) only surfaces on
 * the shim's stderr — invisible in the parent's chat lane. Emitted on the
 * parent runner via `runner.emitMessage` so every attached viewer sees it
 * and it lands in the turn-event buffer for reconnecting viewers.
 *
 * The shim still receives the HTTP error (and exits non-zero) — the chat
 * event is purely the user-facing affordance so the user sees "the agent
 * tried to spawn a session, here's why it didn't work."
 */
export interface WsSessionSpawnFailed {
  type: "session_spawn_failed";
  /** Parent session id — the runner that this event is emitted on. */
  sessionId: string;
  /** Human-readable error message, taken from the orchestrator's response body. */
  message: string;
  /** HTTP status code the spawn route returned (400, 404, 409, 429, 500…). */
  statusCode: number;
  /**
   * Short outcome bucket (`quota_per_turn`, `quota_per_parent`, `invalid_request`,
   * `parent_missing`, `error`) for the UI to pick a tailored copy line.
   */
  reason:
    | "quota_per_turn"
    | "quota_per_parent"
    | "invalid_request"
    | "parent_missing"
    | "error";
  /** Title the agent requested (or the prompt's derived slug). */
  title?: string;
  /**
   * First line of the prompt the spawn was meant to kick off, truncated to
   * 200 chars so the chat card has enough context to tell the user *what*
   * failed without bloating the buffer.
   */
  promptPreview?: string;
  /**
   * docs/162 — true when the rejected spawn was an Ops `--shipit-source` fix
   * session. Lets the failure card tailor its copy (e.g. a 403 here means "no
   * write access to the ShipIt repo — produce an incident report instead",
   * not a generic quota/parent error).
   */
  shipitSource?: boolean;
  /** ISO8601 timestamp the failure was recorded at. */
  failedAt: string;
}

/**
 * Server → Client: a file review's comment set changed out-of-band (docs/125).
 * Emitted when the chat-native review subagent writes anchored comments via the
 * `submit_review_comments` tool. Carries the full updated draft so the file
 * preview modal can render the new AI comments live without re-fetching.
 * Broadcast via `runner.emitMessage()` so every attached viewer sees it and it
 * lands in the turn-event buffer for reconnecting viewers.
 */
export interface WsReviewUpdated {
  type: "review_updated";
  sessionId: string;
  filePath: string;
  review: FileReview;
}

/**
 * Server → Client: the agent emitted a piece of self-contained content via the
 * `present` MCP tool (docs/093). The content lives only in the message stream —
 * no files were created in the workspace, so the user can save it explicitly
 * or dismiss it without leaving stray bytes on disk.
 *
 * If `replaceId` is set and matches a previous presentation's `presentId`, the
 * client replaces that entry in-place (revision flow); otherwise the entry is
 * appended and auto-selected. Size of `content` is capped at ~1 MB worker-side.
 */
export interface WsPresentContentMessage {
  type: "present_content";
  sessionId: string;
  /** Unique id for this presentation, returned to the agent as the tool result. */
  presentId: string;
  /** When set, replaces the entry with this id in-place. */
  replaceId?: string;
  /** The actual artifact — HTML string, SVG markup, markdown, or data URI for binaries. */
  content: string;
  /** "text/html", "image/svg+xml", "text/markdown", "image/png", etc. */
  mimeType: string;
  /** Optional display title for the carousel header. */
  title?: string;
  /** ISO8601 timestamp the worker accepted the presentation. */
  createdAt: string;
}

/**
 * Server → Client: drop one or all presentations (docs/093).
 *
 * `presentId` set → drop just that entry (used by the worker-side LRU when it
 * evicts an old presentation). `presentId` omitted → wipe the whole list
 * (session switch, full clear).
 */
export interface WsPresentClearedMessage {
  type: "present_cleared";
  sessionId: string;
  presentId?: string;
}

/** A single presentation entry as carried in a `present_state` replay. */
export interface PresentStateEntry {
  presentId: string;
  content: string;
  mimeType: string;
  title?: string;
  createdAt: string;
}

/**
 * Server → Client: the full current set of presentations for a session
 * (docs/093). Emitted on viewer attach so a tab that was opened after the
 * `present` tool fired — or re-opened after a session switch — hydrates from
 * the runner's authoritative cache rather than relying on the live
 * `present_content` stream it may have missed. Unlike `present_content`, this
 * does NOT bump the unseen badge or auto-switch the right panel; it's a silent
 * state sync.
 */
export interface WsPresentStateMessage {
  type: "present_state";
  sessionId: string;
  presentations: PresentStateEntry[];
}

/**
 * Server → Client: an agent review card was added to chat history (docs/151).
 *
 * Emitted when the chat-native review subagent finishes a review and writes
 * its anchored findings via `submit_review_comments`. The card carries enough
 * metadata to render a summary tile (file path, finding count) inline in the
 * chat transcript; the snapshot + full comment list are fetched lazily on
 * `[open]` click via `GET /api/sessions/:sessionId/agent-reviews/:reviewId`.
 *
 * Broadcast via `runner.emitMessage()` so every attached viewer sees it and
 * it lands in the turn-event buffer for reconnecting viewers.
 */
export interface WsAgentReviewAdded {
  type: "agent_review_added";
  sessionId: string;
  filePath: string;
  reviewId: string;
  fileType: "markdown" | "code";
  snapshotHash: string;
  findingCount: number;
  summary?: string;
  createdAt: string;
}

/**
 * docs/163 — the Native sink of a voice note. Emitted via `runner.emitMessage`
 * so it buffers into the turn-event log and survives reconnects. Carries only
 * the ear-shaped `headline` (never the full body); the client decides whether
 * to autoplay based on `needsAttention` + hands-free mode. `id` is synthetic
 * (not a turnId) so the playback-store can cache its audio independently.
 */
export interface WsVoiceNote {
  type: "voice_note";
  sessionId: string;
  id: string;
  headline: string;
  needsAttention: boolean;
  kind: VoiceNoteSource;
  createdAt: string;
}

/**
 * docs/164 — the inline bug-report consent card. Emitted via
 * `runner.emitMessage` (so it buffers into the turn-event log and survives
 * reconnects) after the agent's `report_shipit_bug` draft is redacted
 * server-side. Carries the EXACT redacted payload the user will review: the
 * `title` and the single editable `body`. `stage2Ran: false` flags that the
 * deep semantic redaction pass didn't complete, so the card warns the user to
 * review carefully. Nothing is filed until the user confirms.
 */
export interface WsBugReportCard {
  type: "bug_report_card";
  sessionId: string;
  /** Stable id — used to update the card in place (filed / failed). */
  cardId: string;
  title: string;
  body: string;
  /** False → "deep privacy check didn't run, review carefully" flag. */
  stage2Ran: boolean;
  /** Which session produced it — shown for transparency. */
  producer: "session" | "ops";
  /** GitHub login the issue will be filed as (the user's own identity). */
  filedAs?: string;
  createdAt: string;
}

/** docs/164 — terminal success state for a bug-report card. */
export interface WsBugReportFiled {
  type: "bug_report_filed";
  sessionId: string;
  cardId: string;
  number: number;
  url: string;
}

/** docs/164 — terminal failure state for a bug-report card. */
export interface WsBugReportFailed {
  type: "bug_report_failed";
  sessionId: string;
  cardId: string;
  message: string;
  /** True when the failure is a GitHub permission/scope error → reconnect prompt. */
  scopeError?: boolean;
}

/**
 * docs/177 — the do-then-surface provenance card for an agent issue write,
 * emitted via `runner.emitMessage` (so it buffers into the turn-event log and
 * survives reconnects) right after a brokered write completes. Carries the full
 * `IssueWriteCard` (display fields + the undo snapshot). Persisted in-band via
 * `emitChatCard` so it survives a switch/reload; the undo transition patches it.
 */
export interface WsIssueWriteCard {
  type: "issue_write_card";
  sessionId: string;
  card: IssueWriteCard;
}

/**
 * docs/177 — an issue-write card's undo lifecycle transition (undoing →
 * undone | failed). Patched into the persisted card in place so the terminal
 * state survives a reload; idempotent on the client (keyed by `cardId`).
 */
export interface WsIssueWriteUpdate {
  type: "issue_write_update";
  sessionId: string;
  cardId: string;
  undoState: IssueWriteUndoState;
  /** Set when `undoState === "failed"`. */
  errorMessage?: string;
}

/**
 * docs/178 — transient "Compacting…" progress indicator. Emit-only (NOT
 * persisted): it has no place in the scrollback once the matching
 * `WsCompactionCard` lands. `active:true` shows the indicator, `active:false`
 * clears it. Both CLIs may compact unsolicited mid-turn, so this can arrive
 * without the user having typed `/compact`.
 */
export interface WsCompactionStatus {
  type: "compaction_status";
  sessionId: string;
  active: boolean;
  trigger?: "manual" | "auto";
}

/**
 * docs/178 — the persisted "Context compacted" transcript card. Emitted via
 * `emitChatCard` so it both broadcasts live AND records in-band with the turn,
 * surviving a reconnect, a session switch, and a full reload (the recurring
 * ephemeral-card bug class — see CLAUDE.md). Carries the shared `CompactionCard`.
 */
export interface WsCompactionCard {
  type: "compaction_card";
  sessionId: string;
  card: CompactionCard;
}

export type WsServerMessage =
  | WsAgentEvent
  | WsVoiceNote
  | WsCompactionStatus
  | WsCompactionCard
  | WsBugReportCard
  | WsBugReportFiled
  | WsBugReportFailed
  | WsIssueWriteCard
  | WsIssueWriteUpdate
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsAuthRequired
  | WsAgentAuthPending
  | WsAgentAuthComplete
  | WsAgentAuthFailed
  | WsSessionList
  | WsSessionStarted
  | WsSessionRenamed
  | WsDocList
  | WsDocContent
  | WsFileTree
  | WsFileContent
  | WsLogEntry
  | WsUsageStats
  | WsUsageUpdate
  | WsTurnUsageUpdate
  | WsTemplateApplied
  | WsGlobalSettings
  | WsFilesChanged
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubRemotes
  | WsGitHubBranches
  | WsGitIdentityRequired
  | WsGitIdentitySet
  | WsGitHubSearchResults
  | WsPrStatus
  | WsModelInfo
  | WsTerminalOutput
  | WsTerminalExit
  | WsTerminalReconnecting
  | WsMessageQueued
  | WsQueueUpdated
  | WsMessageSteered
  | WsAgentListMessage
  | WsAgentInterrupted
  | WsContainerRestarting
  | WsFullResetComplete
  | WsClearLogs
  | WsTurnDiff
  | WsSessionStatus
  | WsSessionAgentStarted
  | WsSessionAgentFinished
  | WsRepoStatus
  | WsRepoWarmReady
  | WsRepoList
  | WsPrLifecycleUpdate
  | WsSystemUserMessage
  | WsSystemNotice
  | WsCommitLinked
  | WsRewindComplete
  | WsRewindPreview
  | WsRewindSnapshotAvailable
  | WsRewindRestored
  | WsSessionForked
  | WsForkBreadcrumb
  | WsSessionSpawned
  | WsSessionSpawnFailed
  | WsServiceStatus
  | WsServiceList
  | WsServiceLog
  | WsServiceLogBuffer
  | WsServiceOom
  | WsSessionMemoryExhausted
  | WsPreviewError
  | WsComposeError
  | WsStackError
  | WsComposeNotConfigured
  | WsSecretsStatus
  | WsInstallStatus
  | WsInstallLog
  | WsMcpServerStatus
  | WsGitPushRejected
  | WsRebaseStarted
  | WsRebaseConflicts
  | WsRebaseComplete
  | WsRebaseAborted
  | WsAutoResolveStarted
  | WsAutoResolveResult
  | WsReviewUpdated
  | WsAgentReviewAdded
  | WsPresentContentMessage
  | WsPresentClearedMessage
  | WsPresentStateMessage
  | WsSubscriptionLimits;
