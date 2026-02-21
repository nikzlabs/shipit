import type { ImageAttachment, FileContextRef, PermissionMode } from "./attachment-types.js";
import type { AgentId } from "../agents/agent-process.js";
import type { WsGeneratePRDescription } from "./github-types.js";
import type { WsTerminalStart, WsTerminalInput, WsTerminalResize, WsClearLogs } from "./terminal-types.js";
import type { WsForkThread, WsSwitchThread } from "./thread-types.js";
import type {
  WsInitiateDeploy,
  WsCancelDeploy,
} from "./deployment-types.js";

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

export interface WsListSessions {
  type: "list_sessions";
}

export interface WsNewSession {
  type: "new_session";
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

export interface WsPasteAuthCode {
  type: "paste_auth_code";
  code: string;
}

export interface WsStartAuth {
  type: "start_auth";
}

// ---- Agent selection (per-connection state, must stay on WS) ----

/** Client → Server: set the active agent for this connection. */
export interface WsSetAgentMessage {
  type: "set_agent";
  agentId: AgentId;
}

// ---- Interrupt messages ----

/** Client → Server: interrupt the currently running Claude process. */
export interface WsInterruptClaude {
  type: "interrupt_claude";
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
  | WsListSessions
  | WsNewSession
  | WsGetChatHistory
  | WsClearLogs
  | WsAnswerQuestion
  | WsListTemplates
  | WsSetAgentMessage
  | WsForkThread
  | WsSwitchThread
  | WsPasteAuthCode
  | WsStartAuth
  | WsGeneratePRDescription
  | WsInitiateDeploy
  | WsCancelDeploy
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsHomeCreateRepoWithTemplate
  | WsHomeSendWithRepo
  | WsCancelQueuedMessage
  | WsForkSession
  | WsMergeSession
  | WsInterruptClaude
  | WsInitPreviewConfig
  | WsDiffComment;
