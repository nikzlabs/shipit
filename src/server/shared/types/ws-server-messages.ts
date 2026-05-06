import type { AgentId, AgentEvent } from "./agent-types.js";
import type { GitCommitInfo, SessionInfo, DocEntry, FileTreeNode, FileDiff, RepoInfo, SecretRequirement } from "./domain-types.js";
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

export interface WsAuthRequired {
  type: "auth_required";
  url?: string;
}

export interface WsAuthComplete {
  type: "auth_complete";
}

// ---- Codex (ChatGPT subscription) device-auth types ----

/**
 * Server → Client: the Codex CLI has printed a verification URL + user code
 * during `codex login --device-auth`. The client opens the URL in a new tab
 * and shows the code for the user to enter on auth.openai.com.
 *
 * See feature 119.
 */
export interface WsCodexAuthPending {
  type: "codex_auth_pending";
  /** Verification URL printed by the CLI (`https://auth.openai.com/codex/device`). */
  verificationUri: string;
  /** Short code the user types into the verification page (`XXXX-XXXXX`). */
  userCode: string;
  /** Device-code TTL in seconds (15 min per the OpenAI device-auth spec). */
  expiresInSec: number;
}

/**
 * Server → Client: device-auth flow finished and the Codex credentials are
 * on disk. Receivers should refresh the agent list — `authConfigured` for
 * Codex flips to `true` because the file path now resolves.
 */
export interface WsCodexAuthComplete {
  type: "codex_auth_complete";
}

/**
 * Server → Client: device-auth flow failed. `reason` distinguishes between
 * the well-known terminal states so the UI can offer the right next step
 * (retry, contact support, fall back to API key).
 */
export interface WsCodexAuthFailed {
  type: "codex_auth_failed";
  reason: "timeout" | "denied" | "error";
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
  }[];
  defaultAgentId: AgentId;
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

// ---- Diff review messages (server → client) ----

export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
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
  }[];
  defaultAgentId: AgentId;
}

/** Server → Client: the agent was interrupted by user. */
export interface WsAgentInterrupted {
  type: "agent_interrupted";
}

/**
 * Server → Client: the session's container is being restarted.
 *
 * Emitted at the start of `POST /api/sessions/:id/container/restart`
 * before the runner is disposed. The client shows a "Restarting…"
 * overlay until its WebSocket reconnects, at which point the runner
 * factory creates a fresh container.
 */
export interface WsContainerRestarting {
  type: "container_restarting";
  sessionId: string;
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
}

/** Server → Client: rebase was aborted. */
export interface WsRebaseAborted {
  type: "rebase_aborted";
}

/** Server → Client: Docker Compose stack failed to start. */
export interface WsComposeError {
  type: "compose_error";
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

// ---- Rollback messages (server → client) ----

/** Server → Client: a commit was linked to an assistant message. */
export interface WsCommitLinked {
  type: "commit_linked";
  messageIndex: number;
  commitHash: string;
  parentCommitHash: string;
}

/** Server → Client: rollback completed. */
export interface WsRollbackComplete {
  type: "rollback_complete";
  messageIndex: number;
  mode: "code" | "code_and_chat";
  parentCommitHash: string;
}

/** Server → Client: rewind completed — remove messages after the rewind point. */
export interface WsRewindComplete {
  type: "rewind_complete";
  messageIndex: number;
}

/** Server → Client: a new session was forked from a rollback point. */
export interface WsSessionForked {
  type: "session_forked";
  sessionId: string;
  sessionName: string;
}

export type WsServerMessage =
  | WsAgentEvent
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsAuthRequired
  | WsAuthComplete
  | WsCodexAuthPending
  | WsCodexAuthComplete
  | WsCodexAuthFailed
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
  | WsCommitLinked
  | WsRollbackComplete
  | WsRewindComplete
  | WsSessionForked
  | WsServiceStatus
  | WsServiceList
  | WsServiceLog
  | WsServiceLogBuffer
  | WsServiceOom
  | WsPreviewError
  | WsComposeError
  | WsComposeNotConfigured
  | WsSecretsStatus
  | WsInstallStatus
  | WsInstallLog
  | WsGitPushRejected
  | WsRebaseStarted
  | WsRebaseConflicts
  | WsRebaseComplete
  | WsRebaseAborted;
