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

/**
 * Client → Server: start a chat-native AI review turn (docs/125).
 *
 * Distinct from `send_message` so the orchestrator can authorize the review
 * tool: on receipt the handler sets `runner.activeReviewFilePath` to
 * `reviewFilePath`, and the `submit_review_comments` tool handler rejects any
 * call whose `file_path` doesn't match. A user who simply types
 * "Review docs/foo.md" in the composer goes through `send_message` instead —
 * plain chat, no tool authorization. The text is routed through the same agent
 * code path as `send_message` for everything else.
 */
export interface WsSendReviewMessage {
  type: "send_review_message";
  text: string;
  sessionId?: string;
  /** The file the review tool is authorized to write comments on this turn. */
  reviewFilePath: string;
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

/** Client → Server: interrupt the currently running agent process. */
export interface WsInterruptAgent {
  type: "interrupt_agent";
}

// ---- Preview config messages ----

/** Client → Server: request Claude to generate a docker-compose.yml for preview. */
export interface WsInitPreviewConfig {
  type: "init_preview_config";
}

// ---- Service control messages ----

/** Client → Server: start a manual compose service. */
export interface WsStartService {
  type: "start_service";
  name: string;
}

/** Client → Server: stop a compose service. */
export interface WsStopService {
  type: "stop_service";
  name: string;
}

/** Client → Server: request buffered logs for a compose service. */
export interface WsSubscribeServiceLogs {
  type: "subscribe_service_logs";
  name: string;
}

// ---- Prompt queuing messages ----

/** Client → Server: cancel a specific queued message or clear the entire queue. */
export interface WsCancelQueuedMessage {
  type: "cancel_queued_message";
  /** 0-indexed position in queue to cancel, or "all" to clear the entire queue. */
  position: number | "all";
}

// ---- PR detail panel messages (client → server) ----

/**
 * Client → Server: report whether the PR detail tab is the active right-panel
 * tab for a session (docs/133 Phase 4). Gates the poller's heavier conversation
 * fields (issue comments + review threads) so idle sessions stay cheap.
 */
export interface WsPrTabActive {
  type: "pr_tab_active";
  sessionId: string;
  active: boolean;
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

export type RewindAtGapAction = "chat" | "code" | "both" | "fork";

export interface WsRewindAtGap {
  type: "rewind_at_gap";
  gapPosition: number;
  action: RewindAtGapAction;
  branchName?: string;
}

export interface WsRewindPreviewRequest {
  type: "rewind_preview_request";
  gapPosition: number;
  action: RewindAtGapAction;
}

export interface WsRewindRestoreRequest {
  type: "rewind_restore_request";
  sessionId: string;
}

export type WsClientMessage =
  | WsSendMessage
  | WsSendReviewMessage
  | WsClearLogs
  | WsAnswerQuestion
  | WsSetAgentMessage
  | WsSetModelMessage
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsCancelQueuedMessage
  | WsInterruptAgent
  | WsInitPreviewConfig
  | WsStartService
  | WsStopService
  | WsSubscribeServiceLogs
  | WsRewindAtGap
  | WsRewindPreviewRequest
  | WsRewindRestoreRequest
  | WsPrTabActive;
