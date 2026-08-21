import type { WsServerMessage } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler, HandlerContext, QueuedMessageStash } from "./types.js";

import { handleAgentEvent } from "./agent-event.js";
import { handleTurnSnapshot } from "./turn-snapshot.js";
import { handleAgentInterrupted } from "./agent-interrupted.js";
import { handleActionChecklistCard } from "./action-checklist-card.js";
import { handleBranchAutoResetCard } from "./branch-auto-reset-card.js";
import { handleSessionRenamedCard } from "./session-renamed-card.js";
import { handleBranchSyncedCard } from "./branch-synced-card.js";
import { handleAuthRequired } from "./auth-required.js";
import { handleAutoResolveResult } from "./auto-resolve-result.js";
import { handleAutoResolveStarted } from "./auto-resolve-started.js";
import { handleBackgroundTasks } from "./background-tasks.js";
import { handleBugReportCard } from "./bug-report-card.js";
import { handleBugReportFailed } from "./bug-report-failed.js";
import { handleBugReportFiled } from "./bug-report-filed.js";
import { handleBugReportDismissed } from "./bug-report-dismissed.js";
import { handleEgressPromptCard, handleEgressPromptResolved } from "./egress-card.js";
import { handlePermissionRequestCard } from "./permission-request-card.js";
import { handlePermissionResolved } from "./permission-resolved.js";
import { handleCommitLinked } from "./commit-linked.js";
import { handleCompactionCard } from "./compaction-card.js";
import { handleCompactionStatus } from "./compaction-status.js";
import { handleComposeError } from "./compose-error.js";
import { handleComposeNotConfigured } from "./compose-not-configured.js";
import { handleContainerRestarting } from "./container-restarting.js";
import { handleError } from "./error.js";
import { handleFileTree } from "./file-tree.js";
import { handleFilesChanged } from "./files-changed.js";
import { handlePluginReposUpdated } from "./plugin-repos-updated.js";
import { handleFullResetComplete } from "./full-reset-complete.js";
import { handleForkBreadcrumb } from "./fork-breadcrumb.js";
import { handleGithubStatus } from "./github-status.js";
import { handleGitCommitted } from "./git-committed.js";
import { handleGitIdentityRequired } from "./git-identity-required.js";
import { handleGitLog } from "./git-log.js";
import { handleGitPushRejected } from "./git-push-rejected.js";
import { handleGlobalSettings } from "./global-settings.js";
import { handleInstallLog } from "./install-log.js";
import { handleIssueWriteCard } from "./issue-write-card.js";
import { handleIssueWriteUpdate } from "./issue-write-update.js";
import { handleIssueRefCard } from "./issue-ref-card.js";
import { handleInstallStatus } from "./install-status.js";
import { handleLogAppend } from "./log-append.js";
import { handleLogSnapshot } from "./log-snapshot.js";
import { handleMcpServerStatus } from "./mcp-server-status.js";
import { handleMessageQueued } from "./message-queued.js";
import { handleMessageSteered } from "./message-steered.js";
import { handleModelInfo } from "./model-info.js";
import { handleModelSelectionChanged } from "./model-selection-changed.js";
import { handlePrLifecycleUpdate } from "./pr-lifecycle-update.js";
import { handlePrNotableFiles } from "./pr-notable-files.js";
import { handleResetEligible } from "./reset-eligible.js";
import { handlePresentCleared } from "./present-cleared.js";
import { handlePresentContent } from "./present-content.js";
import { handlePresentState } from "./present-state.js";
import { handlePreviewError } from "./preview-error.js";
import { handlePreviewStatus } from "./preview-status.js";
import { handleQueueUpdated } from "./queue-updated.js";
import { handleRebaseAborted } from "./rebase-aborted.js";
import { handleRebaseComplete } from "./rebase-complete.js";
import { handleRebaseConflicts } from "./rebase-conflicts.js";
import { handleRebaseStarted } from "./rebase-started.js";
import { handleReleaseCard } from "./release-card.js";
import { handleRewindComplete } from "./rewind-complete.js";
import { handleRewindPreview } from "./rewind-preview.js";
import { handleRewindRestored } from "./rewind-restored.js";
import { handleRewindSnapshotAvailable } from "./rewind-snapshot-available.js";
import { handleSecretBlockStatus } from "./secret-block-status.js";
import { handleSecretsStatus } from "./secrets-status.js";
import { handleServiceList } from "./service-list.js";
import { handleServiceStatus } from "./service-status.js";
import { handleSessionForked } from "./session-forked.js";
import { handleSessionMemoryExhausted } from "./session-memory-exhausted.js";
import { handleSessionSpawnFailed } from "./session-spawn-failed.js";
import { handleSessionSpawned } from "./session-spawned.js";
import { handleChildMergedCard } from "./child-merged.js";
import { handleSelfMergeWatchCard } from "./self-merge-watch.js";
import { handleSessionReportCard } from "./session-report.js";
import { handleNonTurnFailureCard, handleNonTurnFailureDismissed } from "./non-turn-failure.js";
import { handleSessionStarted } from "./session-started.js";
import { handleSessionStatus } from "./session-status.js";
import { handleSessionContainerFreshness } from "./session-container-freshness.js";
import { handleSubAgentConsultCard } from "./sub-agent-consult-card.js";
import { handleSubAgentSpawn } from "./sub-agent-spawn.js";
import { handleSubagentReportUpdate } from "./subagent-report-update.js";
import { handleSystemNotice } from "./system-notice.js";
import { handleSystemUserMessage } from "./system-user-message.js";
import { handleTemplateApplied } from "./template-applied.js";
import { handleTerminalExit } from "./terminal-exit.js";
import { handleTerminalOutput } from "./terminal-output.js";
import { handleTurnDiff } from "./turn-diff.js";
import { handleTurnUsageUpdate } from "./turn-usage-update.js";
import { handleUsageUpdate } from "./usage-update.js";
import { handleVoiceNote } from "./voice-note.js";

export type { HandlerContext, Handler } from "./types.js";

/** Shorthand for the `type` field of any server → client message. */
export type WsMessageType = WsServerMessage["type"];

/**
 * Per-type narrowing helper: given a discriminator string `T`, resolves to
 * the specific variant of `WsServerMessage` with `type: T`.
 *
 * The dispatcher map below is typed as `Partial<{ [T in WsMessageType]:
 * Handler<WsMessageForType<T>> }>` so each entry's handler receives the
 * narrowed payload — no `any`, no manual casts at call sites.
 */
type WsMessageForType<T extends WsMessageType> = Extract<WsServerMessage, { type: T }>;

type MessageHandlerMap = {
  [T in WsMessageType]?: Handler<WsMessageForType<T>>;
};

/**
 * Dispatcher map from WS message `type` to its dedicated handler.
 *
 * Messages whose handlers live elsewhere (delivered via SSE / `useServerEvents`,
 * or intentionally ignored on the client) are simply absent from the map; the
 * dispatcher call site does an optional-chained lookup so missing types are
 * a no-op rather than an error.
 */
export const messageHandlers: MessageHandlerMap = {
  action_checklist_card: handleActionChecklistCard,
  auto_resolve_result: handleAutoResolveResult,
  auto_resolve_started: handleAutoResolveStarted,
  branch_auto_reset_card: handleBranchAutoResetCard,
  session_renamed_card: handleSessionRenamedCard,
  branch_synced_card: handleBranchSyncedCard,
  agent_event: handleAgentEvent,
  turn_snapshot: handleTurnSnapshot,
  agent_interrupted: handleAgentInterrupted,
  auth_required: handleAuthRequired,
  background_tasks: handleBackgroundTasks,
  bug_report_card: handleBugReportCard,
  bug_report_failed: handleBugReportFailed,
  bug_report_filed: handleBugReportFiled,
  bug_report_dismissed: handleBugReportDismissed,
  egress_prompt_card: handleEgressPromptCard,
  egress_prompt_resolved: handleEgressPromptResolved,
  permission_request_card: handlePermissionRequestCard,
  permission_resolved: handlePermissionResolved,
  commit_linked: handleCommitLinked,
  compaction_card: handleCompactionCard,
  compaction_status: handleCompactionStatus,
  compose_error: handleComposeError,
  compose_not_configured: handleComposeNotConfigured,
  container_restarting: handleContainerRestarting,
  error: handleError,
  file_tree: handleFileTree,
  files_changed: handleFilesChanged,
  plugin_repos_updated: handlePluginReposUpdated,
  full_reset_complete: handleFullResetComplete,
  fork_breadcrumb: handleForkBreadcrumb,
  git_committed: handleGitCommitted,
  git_identity_required: handleGitIdentityRequired,
  git_log: handleGitLog,
  git_push_rejected: handleGitPushRejected,
  github_status: handleGithubStatus,
  global_settings: handleGlobalSettings,
  install_log: handleInstallLog,
  install_status: handleInstallStatus,
  issue_write_card: handleIssueWriteCard,
  issue_write_update: handleIssueWriteUpdate,
  issue_ref_card: handleIssueRefCard,
  log_append: handleLogAppend,
  log_snapshot: handleLogSnapshot,
  mcp_server_status: handleMcpServerStatus,
  message_queued: handleMessageQueued,
  message_steered: handleMessageSteered,
  model_info: handleModelInfo,
  model_selection_changed: handleModelSelectionChanged,
  pr_lifecycle_update: handlePrLifecycleUpdate,
  pr_notable_files: handlePrNotableFiles,
  reset_eligible: handleResetEligible,
  present_cleared: handlePresentCleared,
  present_content: handlePresentContent,
  present_state: handlePresentState,
  preview_error: handlePreviewError,
  preview_status: handlePreviewStatus,
  queue_updated: handleQueueUpdated,
  rebase_aborted: handleRebaseAborted,
  rebase_complete: handleRebaseComplete,
  rebase_conflicts: handleRebaseConflicts,
  rebase_started: handleRebaseStarted,
  release_card: handleReleaseCard,
  rewind_complete: handleRewindComplete,
  rewind_preview: handleRewindPreview,
  rewind_restored: handleRewindRestored,
  rewind_snapshot_available: handleRewindSnapshotAvailable,
  secret_block_status: handleSecretBlockStatus,
  secrets_status: handleSecretsStatus,
  service_list: handleServiceList,
  service_status: handleServiceStatus,
  session_forked: handleSessionForked,
  session_memory_exhausted: handleSessionMemoryExhausted,
  session_report_card: handleSessionReportCard,
  non_turn_failure_card: handleNonTurnFailureCard,
  non_turn_failure_dismissed: handleNonTurnFailureDismissed,
  session_spawn_failed: handleSessionSpawnFailed,
  session_spawned: handleSessionSpawned,
  child_merged_card: handleChildMergedCard,
  self_merge_watch_card: handleSelfMergeWatchCard,
  session_started: handleSessionStarted,
  session_status: handleSessionStatus,
  session_container_freshness: handleSessionContainerFreshness,
  sub_agent_consult_card: handleSubAgentConsultCard,
  sub_agent_spawn: handleSubAgentSpawn,
  subagent_report_update: handleSubagentReportUpdate,
  system_notice: handleSystemNotice,
  system_user_message: handleSystemUserMessage,
  template_applied: handleTemplateApplied,
  terminal_exit: handleTerminalExit,
  terminal_output: handleTerminalOutput,
  turn_diff: handleTurnDiff,
  turn_usage_update: handleTurnUsageUpdate,
  usage_update: handleUsageUpdate,
  voice_note: handleVoiceNote,
};

/**
 * Message types whose `sessionId` names the session that OWNS the chat
 * transcript they belong to — cards, notices, and the transient chips that sit
 * beside them. The client keeps exactly one transcript in memory (the active
 * session's `messages` array), so applying one of these for any other session
 * writes it into the wrong scrollback.
 *
 * That is not hypothetical: the per-session WS is keyed off the *route*
 * (`urlSessionId`) while every handler writes through the *store*
 * (`useSessionStore.sessionId`). Those two agree in the steady state but not
 * across every switch/fork/claim transition, and a card arriving inside that
 * window used to land in whichever session was active — the symptom this set
 * exists to prevent. Cross-session messages that legitimately describe *other*
 * sessions (`session_status` sidebar dots, `pr_lifecycle_update`,
 * `reset_eligible`, `usage_update`, `session_forked`, `rewind_restored`, …) are
 * deliberately absent — they are keyed by their own `sessionId` inside their
 * stores and must keep flowing.
 *
 * Dropping (rather than re-routing) is correct: every one of these is either
 * persisted in the owning session's chat history — so switching to that session
 * rehydrates it — or transient live activity that is meaningless once stale.
 */
const TRANSCRIPT_SCOPED_MESSAGES: ReadonlySet<WsMessageType> = new Set<WsMessageType>([
  "action_checklist_card",
  "branch_auto_reset_card",
  "branch_synced_card",
  "bug_report_card",
  "bug_report_failed",
  "bug_report_filed",
  "bug_report_dismissed",
  "child_merged_card",
  "compaction_card",
  "compaction_status",
  "egress_prompt_card",
  "egress_prompt_resolved",
  "issue_ref_card",
  "issue_write_card",
  "issue_write_update",
  "permission_request_card",
  "permission_resolved",
  "release_card",
  "self_merge_watch_card",
  "session_renamed_card",
  "session_report_card",
  "non_turn_failure_card",
  "non_turn_failure_dismissed",
  "session_spawn_failed",
  "session_spawned",
  "session_container_freshness",
  "secret_block_status",
  "sub_agent_consult_card",
  "sub_agent_spawn",
  "subagent_report_update",
  "system_notice",
  "system_user_message",
  "message_steered",
  "turn_snapshot",
  "voice_note",
]);

/**
 * True when a transcript-scoped message belongs to a session other than the one
 * currently rendered. Lenient by construction: a message with no `sessionId`,
 * or a store with no active session, is never dropped — the guard only fires on
 * a positive mismatch.
 */
function isForeignTranscriptMessage(data: WsServerMessage): boolean {
  if (!TRANSCRIPT_SCOPED_MESSAGES.has(data.type)) return false;
  const msgSessionId = (data as { sessionId?: string }).sessionId;
  const activeSessionId = useSessionStore.getState().sessionId;
  return !!msgSessionId && !!activeSessionId && msgSessionId !== activeSessionId;
}

/**
 * Dispatch a single WS server message to its handler (if any).
 *
 * Performs the discriminated-union narrowing here so handlers can be
 * typed precisely against their specific message variant without callers
 * having to know which key to index.
 */
export function dispatchMessage(ctx: HandlerContext, data: WsServerMessage): void {
  if (isForeignTranscriptMessage(data)) return;
  const handler = messageHandlers[data.type] as Handler | undefined;
  handler?.(ctx, data);
}

/** Create a fresh queued-message stash. See `QueuedMessageStash` doc. */
export function createQueuedMessageStash(): QueuedMessageStash {
  return new Map();
}
