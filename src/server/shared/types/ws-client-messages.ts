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
  /**
   * Pre-formatted answer text used as the prompt to the agent and the
   * user's chat bubble. The client builds this from `answers` plus the
   * question text so commas inside an answer aren't ambiguous with the
   * separator between answers (single question: bare text; multiple
   * questions: "- {question}: {answer}" per line). Optional for back-compat
   * with older clients — the server falls back to joining the answers map.
   */
  text?: string;
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

export type RewindAtGapAction = "chat" | "code" | "both" | "fork";

export interface WsRewindAtGap {
  type: "rewind_at_gap";
  gapPosition: number;
  action: RewindAtGapAction;
  /**
   * Human-readable title for the forked session. Required when action is
   * `fork`; ignored otherwise. The new branch name is derived server-side
   * from the active session's branch (with a fresh slug) — the user does
   * not pick branch names.
   */
  sessionName?: string;
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

/**
 * Client → Server: confirm and file a bug report (docs/164). Sent only when
 * the user clicks "Submit report" on the inline consent card. Carries the
 * final, possibly-edited `title` and `body` — what the user confirmed in the
 * card is exactly what gets filed. The server has the producer/marker context
 * stashed against `cardId`; the client only round-trips the editable fields.
 */
export interface WsSubmitBugReport {
  type: "submit_bug_report";
  cardId: string;
  title: string;
  body: string;
}

export type WsClientMessage =
  | WsSendMessage
  | WsSubmitBugReport
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
