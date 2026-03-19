import type { ClaudeEvent } from "./claude-types.js";
import type { AgentId, AgentEvent } from "./agent-types.js";
import type { GitCommitInfo, SessionInfo, DocEntry, FileTreeNode, WsChatHistoryMessage, FileDiff, RepoInfo } from "./domain-types.js";
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
import type {
  WsDeployTargets,
  WsProjectSettings,
  WsDeployStatus,
  WsDeployComplete,
  WsDeployError,
  WsDeployHistory,
} from "./deployment-types.js";
import type { WsUsageStats, WsUsageUpdate } from "./usage-types.js";

export interface WsClaudeEvent {
  type: "claude_event";
  event: ClaudeEvent;
}

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

export interface WsChatHistory {
  type: "chat_history";
  sessionId: string;
  messages: WsChatHistoryMessage[];
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

/** Server → Client: the queue changed (after a cancel or session switch). */
export interface WsQueueUpdated {
  type: "queue_updated";
  /** Current queue contents after the change. */
  queue: { text: string; position: number }[];
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

/** Server → Client: Claude was interrupted by user. */
export interface WsClaudeInterrupted {
  type: "claude_interrupted";
}

/** Server → Client: full reset completed successfully. */
export interface WsFullResetComplete {
  type: "full_reset_complete";
}

/** Server → Client: install command status update. */
export interface WsInstallStatus {
  type: "install_status";
  status: "running" | "complete" | "error";
  /** Human-readable message (e.g. error details). */
  message?: string;
}

// ---- Startup step messages ----

export type StartupStepId = "fetch" | "install" | "dev_server";
export type StartupStepStatus = "pending" | "running" | "complete" | "error";

/** Server → Client: progressive startup step update. */
export interface WsStartupStep {
  type: "startup_step";
  stepId: StartupStepId;
  status: StartupStepStatus;
  /** Duration in milliseconds (set when status is "complete"). */
  durationMs?: number;
  /** Human-readable error message (set when status is "error"). */
  message?: string;
  /** Rolling log lines (last N) for this step. */
  logLines?: string[];
  /** Session that owns this step — client discards stale messages. */
  sessionId?: string;
}

/** Server → Client: no preview config found for the session. */
export interface WsPreviewConfigMissing {
  type: "preview_config_missing";
  /** What was checked and not found. */
  checked: ("shipit.yaml" | "package.json")[];
}

/** Server → Client: shipit.yaml exists but is malformed. */
export interface WsPreviewConfigError {
  type: "preview_config_error";
  message: string;
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
  | WsClaudeEvent
  | WsAgentEvent
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsAuthRequired
  | WsAuthComplete
  | WsSessionList
  | WsSessionStarted
  | WsSessionRenamed
  | WsDocList
  | WsDocContent
  | WsChatHistory
  | WsFileTree
  | WsFileContent
  | WsLogEntry
  | WsUsageStats
  | WsUsageUpdate
  | WsTemplateApplied
  | WsGlobalSettings
  | WsFilesChanged
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubRemotes
  | WsGitHubBranches
  | WsGitIdentityRequired
  | WsGitIdentitySet
  | WsDeployTargets
  | WsProjectSettings
  | WsDeployStatus
  | WsDeployComplete
  | WsDeployError
  | WsDeployHistory
  | WsGitHubSearchResults
  | WsPrStatus
  | WsModelInfo
  | WsTerminalOutput
  | WsTerminalExit
  | WsTerminalReconnecting
  | WsMessageQueued
  | WsQueueUpdated
  | WsAgentListMessage
  | WsClaudeInterrupted
  | WsFullResetComplete
  | WsInstallStatus
  | WsPreviewConfigMissing
  | WsPreviewConfigError
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
  | WsStartupStep;
