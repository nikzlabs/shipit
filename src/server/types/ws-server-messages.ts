import type { ClaudeEvent } from "./claude-types.js";
import type { AgentId, AgentEvent } from "./agent-types.js";
import type { GitCommitInfo, SessionInfo, FeatureInfo, ProjectTemplate, FileTreeNode, WsChatHistoryMessage, FileDiff } from "./domain-types.js";
import type {
  WsGitHubStatus,
  WsGitHubPushResult,
  WsGitHubPullResult,
  WsGitHubRemotes,
  WsGitHubPRCreated,
  WsGitHubBranches,
  WsGitHubSearchResults,
  WsGeneratedPRDescription,
  WsPrStatus,
  WsMergePrResult,
} from "./github-types.js";
import type { WsTerminalOutput, WsTerminalExit, WsLogEntry, WsClearLogs } from "./terminal-types.js";
import type { WsCheckpointCreated, WsThreadList, WsThreadSwitched, WsThreadForked } from "./thread-types.js";
import type {
  WsDeployTargets,
  WsDeployConfigSaved,
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

export interface WsRollbackComplete {
  type: "rollback_complete";
  commitHash: string;
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
  files: string[];
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
  agents: Array<{
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
  }>;
  defaultAgentId: AgentId;
}

// ---- Template messages ----

export interface WsTemplateList {
  type: "template_list";
  templates: Array<Omit<ProjectTemplate, "files">>;
}

export interface WsTemplateApplied {
  type: "template_applied";
  templateId: string;
  name: string;
}

// ---- Feature server messages ----

export interface WsFeatureList {
  type: "feature_list";
  features: FeatureInfo[];
}

// ---- Model info ----

/** Sent once after the Claude CLI init event, and on reconnect. */
export interface WsModelInfo {
  type: "model_info";
  model: string;
  contextWindowTokens: number;
}

// ---- Home screen server messages ----

export interface WsHomeRepoReady {
  type: "home_repo_ready";
  success: boolean;
  repoUrl?: string;
  sessionId?: string;
  message?: string;
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
  queue: Array<{ text: string; position: number }>;
}

// ---- Worktree session messages (server → client) ----

export interface WsSessionForked {
  type: "session_forked";
  session: SessionInfo;
  parentSessionId: string;
}

export interface WsWorktreeList {
  type: "worktree_list";
  worktrees: Array<{
    sessionId: string;
    branch: string;
    path: string;
  }>;
}

export interface WsMergeResult {
  type: "merge_result";
  success: boolean;
  message: string;
  conflicts?: string[];
}

// ---- Diff review messages (server → client) ----

export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}

export interface WsRejectChangesComplete {
  type: "reject_changes_complete";
  revertedFiles: string[];
  commitHash: string;
}

// ---- Agent registry server messages ----

export interface WsAgentListMessage {
  type: "agent_list";
  agents: Array<{
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
  }>;
  defaultAgentId: AgentId;
}

export interface WsAgentEnvSetMessage {
  type: "agent_env_set";
  agentId: AgentId;
  key: string;
  success: boolean;
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

export type WsServerMessage =
  | WsClaudeEvent
  | WsAgentEvent
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsRollbackComplete
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
  | WsTemplateList
  | WsTemplateApplied
  | WsFeatureList
  | WsGlobalSettings
  | WsFilesChanged
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubPullResult
  | WsGitHubRemotes
  | WsGitHubPRCreated
  | WsGitHubBranches
  | WsGitIdentityRequired
  | WsGitIdentitySet
  | WsCheckpointCreated
  | WsThreadList
  | WsThreadSwitched
  | WsThreadForked
  | WsDeployTargets
  | WsDeployConfigSaved
  | WsProjectSettings
  | WsDeployStatus
  | WsDeployComplete
  | WsDeployError
  | WsDeployHistory
  | WsGitHubSearchResults
  | WsGeneratedPRDescription
  | WsPrStatus
  | WsMergePrResult
  | WsModelInfo
  | WsTerminalOutput
  | WsTerminalExit
  | WsHomeRepoReady
  | WsMessageQueued
  | WsQueueUpdated
  | WsSessionForked
  | WsWorktreeList
  | WsMergeResult
  | WsAgentListMessage
  | WsAgentEnvSetMessage
  | WsClaudeInterrupted
  | WsFullResetComplete
  | WsInstallStatus
  | WsPreviewConfigMissing
  | WsPreviewConfigError
  | WsClearLogs
  | WsTurnDiff
  | WsRejectChangesComplete;
