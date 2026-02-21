import type { ImageAttachment, FileContextRef, PermissionMode } from "./attachment-types.js";
import type { AgentId } from "./agent-types.js";
import type {
  WsGitHubSetToken,
  WsGitHubPush,
  WsGitHubPull,
  WsGitHubSetRemote,
  WsGitHubLogout,
  WsGitHubCreatePR,
  WsGeneratePRDescription,
  WsMergePr,
} from "./github-types.js";
import type { WsTerminalStart, WsTerminalInput, WsTerminalResize, WsClearLogs, WsPreviewError } from "./terminal-types.js";
import type { WsCreateCheckpoint, WsForkThread, WsSwitchThread } from "./thread-types.js";
import type {
  WsDeployConfigure,
  WsInitiateDeploy,
  WsCancelDeploy,
  WsDeleteDeployConfig,
} from "./deployment-types.js";

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

export interface WsRollback {
  type: "rollback";
  commitHash: string;
}

export interface WsListSessions {
  type: "list_sessions";
}

export interface WsNewSession {
  type: "new_session";
}

export interface WsArchiveSession {
  type: "archive_session";
  sessionId: string;
}

export interface WsRenameSession {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface WsGetChatHistory {
  type: "get_chat_history";
  sessionId: string;
}

export interface WsAnswerQuestion {
  type: "answer_question";
  toolUseId: string;
  answers: Record<string, string>;
}

export interface WsListTemplates {
  type: "list_templates";
}

export interface WsApplyTemplate {
  type: "apply_template";
  templateId: string;
}

// ---- Home screen messages ----

export interface WsHomeCreateRepoWithTemplate {
  type: "home_create_repo_with_template";
  repoName: string;
  description?: string;
  isPrivate?: boolean;
  templateId: string;
}

export interface WsHomeSendWithRepo {
  type: "home_send_with_repo";
  repoUrl: string;
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

// ---- Git identity messages ----

export interface WsSetGitIdentity {
  type: "set_git_identity";
  name: string;
  email: string;
}

// ---- Global settings messages ----

/** Fetch all global settings in a single request. */
export interface WsGetGlobalSettings {
  type: "get_global_settings";
}

/** Save global settings. Only provided fields are updated. */
export interface WsSaveGlobalSettings {
  type: "save_global_settings";
  gitIdentity?: { name: string; email: string };
  systemPrompt?: string;
}

export interface WsSetApiKey {
  type: "set_api_key";
  key: string;
}

export interface WsPasteAuthCode {
  type: "paste_auth_code";
  code: string;
}

export interface WsClearApiKey {
  type: "clear_api_key";
}

export interface WsStartAuth {
  type: "start_auth";
}

// ---- Interrupt messages ----

/** Client → Server: interrupt the currently running Claude process. */
export interface WsInterruptClaude {
  type: "interrupt_claude";
}

/** Client → Server: wipe all persistent state and reset the container. */
export interface WsFullReset {
  type: "full_reset";
}

// ---- Agent registry messages ----

export interface WsSetAgentEnvMessage {
  type: "set_agent_env";
  agentId: AgentId;
  key: string;
  value: string;
}

export interface WsSetAgentMessage {
  type: "set_agent";
  agentId: AgentId;
}

// ---- Preview config messages ----

/** Client → Server: request Claude to generate a shipit.yaml config. */
export interface WsInitPreviewConfig {
  type: "init_preview_config";
}

// ---- Prompt queuing messages ----

/** Client → Server: cancel a specific queued message or clear the entire queue. */
export interface WsCancelQueuedMessage {
  type: "cancel_queued_message";
  /** 0-indexed position in queue to cancel, or "all" to clear the entire queue. */
  position: number | "all";
}

// ---- Diff review messages (client → server) ----

export interface WsRejectChanges {
  type: "reject_changes";
  /** Commit to revert to. */
  fromCommit: string;
  /** Files to revert. Empty array = revert all. */
  files: string[];
}

export interface WsDiffComment {
  type: "diff_comment";
  comments: Array<{
    file: string;
    line: number;
    text: string;
  }>;
}

// ---- Worktree session messages (client → server) ----

export interface WsForkSession {
  type: "fork_session";
  /** Branch name for the new worktree. */
  branchName: string;
  /** Optional commit to start from (defaults to HEAD). */
  startPoint?: string;
}

export interface WsMergeSession {
  type: "merge_session";
  /** Session ID to merge from. */
  sourceSessionId: string;
}

export type WsClientMessage =
  | WsSendMessage
  | WsRollback
  | WsListSessions
  | WsNewSession
  | WsArchiveSession
  | WsRenameSession
  | WsGetChatHistory
  | WsClearLogs
  | WsPreviewError
  | WsAnswerQuestion
  | WsListTemplates
  | WsApplyTemplate
  | WsGitHubSetToken
  | WsGitHubPush
  | WsGitHubPull
  | WsGitHubSetRemote
  | WsGitHubLogout
  | WsGitHubCreatePR
  | WsSetGitIdentity
  | WsGetGlobalSettings
  | WsSaveGlobalSettings
  | WsCreateCheckpoint
  | WsForkThread
  | WsSwitchThread
  | WsSetApiKey
  | WsPasteAuthCode
  | WsClearApiKey
  | WsStartAuth
  | WsGeneratePRDescription
  | WsMergePr
  | WsDeployConfigure
  | WsInitiateDeploy
  | WsCancelDeploy
  | WsDeleteDeployConfig
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsHomeCreateRepoWithTemplate
  | WsHomeSendWithRepo
  | WsSetAgentMessage
  | WsCancelQueuedMessage
  | WsForkSession
  | WsMergeSession
  | WsInterruptClaude
  | WsSetAgentEnvMessage
  | WsFullReset
  | WsInitPreviewConfig
  | WsRejectChanges
  | WsDiffComment;
