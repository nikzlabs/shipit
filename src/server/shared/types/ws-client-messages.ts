import type { ImageAttachment, FileContextRef, PermissionMode, UploadRef } from "./attachment-types.js";
import type { AgentId } from "../../session/agents/agent-process.js";
import type { IssueRef } from "./domain-types/issue.js";
import type { BillingMode } from "../catalogue/types.js";
import type { WsTerminalStart, WsTerminalInput, WsTerminalResize, WsSubscribeLogs, WsLogClear } from "./terminal-types.js";

export interface WsSendMessage {
  type: "send_message";
  requestId?: string;
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  uploads?: UploadRef[];
  permissionMode?: PermissionMode;
  userReview?: { filePaths: string[]; commentCount: number };
  /** Per-send override: false skips; true/absent follows the global setting. */
  resetMergedBranch?: boolean;
  /** Independent per-send override, with the same semantics as resetMergedBranch. */
  compactContext?: boolean;
  /** Creation origin on the first message; ignored after warm graduation. */
  issueRef?: IssueRef;
  dictated?: boolean;
}

export interface WsAnswerQuestion {
  type: "answer_question";
  requestId?: string;
  toolUseId: string;
  answers: Record<string, string>;
  /** Formatted answer avoids ambiguous commas; older clients omit it. */
  text?: string;
  /** Preserve plan mode when the answer resumes the CLI. */
  permissionMode?: PermissionMode;
  dictated?: boolean;
}

export interface WsSetAgentMessage {
  type: "set_agent";
  agentId: AgentId;
}

export interface WsSetModelMessage {
  type: "set_model";
  model: string;
  serviceId?: string;
  billingMode?: BillingMode;
}

export interface WsSetReasoningMessage {
  type: "set_reasoning";
  /** null restores the CLI default. */
  effort: string | null;
}

/** Before the first turn only; clearing removes instructions but keeps parameters. */
export interface WsSetRoleMessage {
  type: "set_role";
  roleName: string | null;
}

export interface WsInterruptAgent {
  type: "interrupt_agent";
}

export interface WsInitPreviewConfig {
  type: "init_preview_config";
}

export interface WsStartService {
  type: "start_service";
  name: string;
}

export interface WsStopService {
  type: "stop_service";
  name: string;
}

export interface WsCancelQueuedMessage {
  type: "cancel_queued_message";
  /** Zero-based position. */
  position: number | "all";
}

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
  /** Required for fork; ignored otherwise. */
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

export interface WsSubmitBugReport {
  type: "submit_bug_report";
  cardId: string;
  title: string;
  body: string;
}

export interface WsDismissBugReport {
  type: "dismiss_bug_report";
  cardId: string;
}

export interface WsUndoIssueWrite {
  type: "undo_issue_write";
  cardId: string;
}

export interface WsResolvePermission {
  type: "resolve_permission";
  requestId: string;
  behavior: "allow" | "deny";
  /** On approval, allow this file for the rest of the session. */
  remember?: boolean;
}

export interface WsEgressDecision {
  type: "egress_decision";
  cardId: string;
  host: string;
  action: "allow-once" | "add" | "deny";
}

export type WsClientMessage =
  | WsSendMessage
  | WsSubmitBugReport
  | WsDismissBugReport
  | WsUndoIssueWrite
  | WsResolvePermission
  | WsEgressDecision
  | WsSubscribeLogs
  | WsLogClear
  | WsAnswerQuestion
  | WsSetAgentMessage
  | WsSetModelMessage
  | WsSetReasoningMessage
  | WsSetRoleMessage
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
