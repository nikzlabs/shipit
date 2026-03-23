import type { ImageAttachment, FileContextRef, PermissionMode, UploadRef } from "./attachment-types.js";
import type { AgentId } from "../../session/agents/agent-process.js";
import type { WsTerminalStart, WsTerminalInput, WsTerminalResize, WsClearLogs } from "./terminal-types.js";

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
}

export interface WsAnswerQuestion {
  type: "answer_question";
  toolUseId: string;
  answers: Record<string, string>;
}

// ---- Agent selection (per-connection state, must stay on WS) ----

/** Client → Server: set the active agent for this connection. */
export interface WsSetAgentMessage {
  type: "set_agent";
  agentId: AgentId;
}

/** Client → Server: set the model for the next turn. */
export interface WsSetModelMessage {
  type: "set_model";
  model: string;
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

// ---- Rollback messages (client → server) ----

/** Client → Server: rollback code only (git reset, chat stays). */
export interface WsRollbackCode {
  type: "rollback_code";
  messageIndex: number;
  parentCommitHash: string;
}

/** Client → Server: rollback code + chat (git reset, fresh CLI session). */
export interface WsRollbackCodeAndChat {
  type: "rollback_code_and_chat";
  messageIndex: number;
  parentCommitHash: string;
}

/** Client → Server: fork as a new session from a rollback point. */
export interface WsForkSessionFromMessage {
  type: "fork_session_from_message";
  messageIndex: number;
  parentCommitHash: string;
}

// ---- Rewind messages (client → server) ----

/** Client → Server: rewind conversation/code to a user message.
 *  - fork_chat: new conversation branch from this point, code unchanged
 *  - rewind_code: git reset to before this message, keep conversation
 *  - rewind_all: git reset + new conversation branch
 */
export interface WsRewindToMessage {
  type: "rewind_to_message";
  messageIndex: number;
  mode: "fork_chat" | "rewind_code" | "rewind_all";
}

export type WsClientMessage =
  | WsSendMessage
  | WsClearLogs
  | WsAnswerQuestion
  | WsSetAgentMessage
  | WsSetModelMessage
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsCancelQueuedMessage
  | WsInterruptClaude
  | WsInitPreviewConfig
  | WsRollbackCode
  | WsRollbackCodeAndChat
  | WsForkSessionFromMessage
  | WsRewindToMessage;
