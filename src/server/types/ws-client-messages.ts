import type { ImageAttachment, FileContextRef, PermissionMode } from "./attachment-types.js";
import type { AgentId } from "../agents/agent-process.js";
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

export interface WsNewSession {
  type: "new_session";
}

export interface WsAnswerQuestion {
  type: "answer_question";
  toolUseId: string;
  answers: Record<string, string>;
}

// ---- Home screen messages ----

export interface WsHomeSendWithRepo {
  type: "home_send_with_repo";
  repoUrl: string;
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

// ---- Session activation (per-connection state — attaches runner, starts watcher) ----

/** Client → Server: activate a session (attach runner, file watcher, preview). */
export interface WsActivateSession {
  type: "activate_session";
  sessionId: string;
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

export type WsClientMessage =
  | WsSendMessage
  | WsNewSession
  | WsClearLogs
  | WsAnswerQuestion
  | WsActivateSession
  | WsSetAgentMessage
  | WsForkThread
  | WsSwitchThread
  | WsInitiateDeploy
  | WsCancelDeploy
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsHomeSendWithRepo
  | WsCancelQueuedMessage
  | WsInterruptClaude
  | WsInitPreviewConfig
  | WsDiffComment;
