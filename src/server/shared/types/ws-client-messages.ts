import type { ImageAttachment, FileContextRef, PermissionMode, UploadRef } from "./attachment-types.js";
import type { AgentId } from "../../session/agents/agent-process.js";
import type { WsTerminalStart, WsTerminalInput, WsTerminalResize, WsSubscribeLogs, WsLogClear } from "./terminal-types.js";

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  /**
   * Set when the message was started by the "Send comments" action on a file
   * preview. The prompt text carries the comments (source of truth); this
   * metadata is persisted onto the user row so the bubble rehydrates as a
   * `UserReviewCard` instead of a plain text bubble after a reload.
   */
  userReview?: { filePaths: string[]; commentCount: number };
  /**
   * docs/218 — per-send intent for the auto-reset-merged-branch control. `false`
   * = the user unticked "start from the latest base" for THIS message (skip the
   * reset). `true`/absent = follow the global setting. Non-sticky: it's a
   * per-message choice, never persisted.
   */
  resetMergedBranch?: boolean;
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
  /**
   * The session's current permission mode, forwarded so answering a clarifying
   * AskUserQuestion resumes in the SAME mode it was asked in. Critical for plan
   * mode: an answer is a fresh `--resume` turn, and without re-pinning
   * `--permission-mode plan` the resumed CLI drops to default mode and starts
   * implementing — i.e. it silently exits plan mode even though the user only
   * answered a clarifying question and never approved a plan (the bug this
   * fixes). Optional for back-compat; the server falls back to the runner's
   * last-applied mode.
   */
  permissionMode?: PermissionMode;
}

/**
 * Client → Server: start a chat-native AI review turn (docs/125, docs/203).
 *
 * Distinct from `send_message` so the orchestrator can authorize the review
 * tool: on receipt the handler sets `runner.activeReviewFilePath` to
 * `reviewFilePath`, and the `submit_review` tool handler rejects any call whose
 * `file_path` doesn't match (and any call outside a review turn). A user who
 * simply types "Review docs/foo.md" in the composer goes through `send_message`
 * instead — plain chat, no tool authorization. The text is routed through the
 * same agent code path as `send_message` for everything else.
 */
export interface WsSendReviewMessage {
  type: "send_review_message";
  text: string;
  sessionId?: string;
  /** The file the review tool is authorized to record a card for this turn. */
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

/**
 * docs/217 — Client → Server: set the per-session reasoning effort for the
 * active agent's own turns (Control B). `effort: null` clears it (CLI default).
 */
export interface WsSetReasoningMessage {
  type: "set_reasoning";
  effort: string | null;
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

/**
 * Client → Server: undo a previously-recorded issue write (docs/177). Sent
 * when the user clicks "Undo" on the provenance card. The server recovers the
 * tracker + undo snapshot from the persisted card (keyed by `cardId`) and
 * performs the reverse brokered write — the client only names the card.
 */
export interface WsUndoIssueWrite {
  type: "undo_issue_write";
  cardId: string;
}

/**
 * Client → Server: answer a sensitive-action permission request (docs/193 /
 * SHI-112). Sent when the user clicks Approve / Deny on the inline
 * `PermissionRequestCard`. The server forwards the decision to the worker's
 * broker (keyed by `requestId`), which unblocks the held bridge/RPC call.
 * `remember` (approve only) adds the file path to the session allow-set so the
 * same file isn't re-prompted.
 */
export interface WsResolvePermission {
  type: "resolve_permission";
  requestId: string;
  behavior: "allow" | "deny";
  remember?: boolean;
}

/**
 * Client → Server: resolve an egress allow-once card (docs/172 / SHI-90). Sent
 * when the user clicks Allow once / Add to allowlist / Deny on the inline
 * `EgressPromptCard`. The server updates the per-session egress policy (keyed by
 * `host`) so the agent's retried connection is allowed, and patches the card to
 * its terminal phase. `allow-once` is single-session-ephemeral; `add` persists
 * for the session.
 */
export interface WsEgressDecision {
  type: "egress_decision";
  cardId: string;
  host: string;
  action: "allow-once" | "add" | "deny";
}

export type WsClientMessage =
  | WsSendMessage
  | WsSubmitBugReport
  | WsUndoIssueWrite
  | WsResolvePermission
  | WsEgressDecision
  | WsSendReviewMessage
  | WsSubscribeLogs
  | WsLogClear
  | WsAnswerQuestion
  | WsSetAgentMessage
  | WsSetModelMessage
  | WsSetReasoningMessage
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsCancelQueuedMessage
  | WsInterruptAgent
  | WsInitPreviewConfig
  | WsStartService
  | WsStopService
  | WsRewindAtGap
  | WsRewindPreviewRequest
  | WsRewindRestoreRequest
  | WsPrTabActive;
