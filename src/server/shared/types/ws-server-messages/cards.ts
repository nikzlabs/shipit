import type {
  IssueWriteCard,
  IssueWriteUndoState,
  IssueRefCard,
  CompactionCard,
  SubAgentConsultCard,
  ActionChecklistCard,
  PresentInlineCard,
  BranchAutoResetCard,
  BranchSyncedCard,
  SessionRenamedCard,
  SessionSettingsChangeCard,
  NonTurnFailureCard,
} from "../domain-types.js";
import type { ReleaseStatusSummary } from "../release-types.js";
import type { VoiceNoteSource } from "../voice-note-types.js";

export interface WsVoiceNote {
  type: "voice_note";
  sessionId: string;
  id: string;
  headline: string;
  kind: VoiceNoteSource;
  createdAt: string;
}

export interface WsBugReportCard {
  type: "bug_report_card";
  sessionId: string;
  cardId: string;
  title: string;
  body: string;
  /** Whether deep semantic redaction completed. */
  stage2Ran: boolean;
  producer: "session" | "ops";
  filedAs?: string;
  createdAt: string;
}

export interface WsBugReportFiled {
  type: "bug_report_filed";
  sessionId: string;
  cardId: string;
  number: number;
  url: string;
}

export interface WsBugReportDismissed {
  type: "bug_report_dismissed";
  sessionId: string;
  cardId: string;
}

export interface WsBugReportFailed {
  type: "bug_report_failed";
  sessionId: string;
  cardId: string;
  message: string;
  scopeError?: boolean;
}

export interface WsEgressPromptCard {
  type: "egress_prompt_card";
  sessionId: string;
  cardId: string;
  host: string;
  createdAt: string;
}

export interface WsEgressPromptResolved {
  type: "egress_prompt_resolved";
  sessionId: string;
  cardId: string;
  phase: "allowed-once" | "added" | "denied";
}

export interface WsPermissionRequestCard {
  type: "permission_request_card";
  sessionId: string;
  requestId: string;
  toolName: string;
  path?: string;
  summary?: string;
  details?: string;
  agentId?: string;
  createdAt: string;
}

export interface WsPermissionResolved {
  type: "permission_resolved";
  sessionId: string;
  requestId: string;
  phase: "approved" | "denied";
  remembered?: boolean;
}

export interface WsIssueWriteCard {
  type: "issue_write_card";
  sessionId: string;
  card: IssueWriteCard;
}

export interface WsIssueWriteUpdate {
  type: "issue_write_update";
  sessionId: string;
  cardId: string;
  undoState: IssueWriteUndoState;
  errorMessage?: string;
}

export interface WsIssueRefCard {
  type: "issue_ref_card";
  sessionId: string;
  card: IssueRefCard;
}

/** Transient; only the completed compaction card is persisted. */
export interface WsCompactionStatus {
  type: "compaction_status";
  sessionId: string;
  active: boolean;
  trigger?: "manual" | "auto";
}

export interface WsCompactionCard {
  type: "compaction_card";
  sessionId: string;
  card: CompactionCard;
}

export interface WsReleaseCard {
  type: "release_card";
  sessionId: string;
  card: ReleaseStatusSummary;
}

export interface WsSubAgentConsultCard {
  type: "sub_agent_consult_card";
  sessionId: string;
  card: SubAgentConsultCard;
}

export interface WsPresentInlineCard {
  type: "present_inline_card";
  sessionId: string;
  card: PresentInlineCard;
}

export interface WsActionChecklistCard {
  type: "action_checklist_card";
  sessionId: string;
  card: ActionChecklistCard;
}

export interface WsBranchAutoResetCard {
  type: "branch_auto_reset_card";
  sessionId: string;
  card: BranchAutoResetCard;
}

export interface WsBranchSyncedCard {
  type: "branch_synced_card";
  sessionId: string;
  card: BranchSyncedCard;
}

export interface WsSessionRenamedCard {
  type: "session_renamed_card";
  sessionId: string;
  card: SessionRenamedCard;
}

export interface WsSessionSettingsChangeCard {
  type: "session_settings_change_card";
  sessionId: string;
  card: SessionSettingsChangeCard;
}

export interface WsNonTurnFailureCard {
  type: "non_turn_failure_card";
  sessionId: string;
  card: NonTurnFailureCard;
}

export interface WsNonTurnFailureDismissed {
  type: "non_turn_failure_dismissed";
  sessionId: string;
  cardId: string;
  dismissedAt: string;
}
