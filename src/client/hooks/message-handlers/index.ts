import type { WsServerMessage } from "../../../server/shared/types.js";
import type { Handler, HandlerContext, QueuedMessageStash } from "./types.js";

import { handleAgentEvent } from "./agent-event.js";
import { handleAgentInterrupted } from "./agent-interrupted.js";
import { handleAuthRequired } from "./auth-required.js";
import { handleClearLogs } from "./clear-logs.js";
import { handleCommitLinked } from "./commit-linked.js";
import { handleComposeError } from "./compose-error.js";
import { handleComposeNotConfigured } from "./compose-not-configured.js";
import { handleContainerRestarting } from "./container-restarting.js";
import { handleError } from "./error.js";
import { handleFileTree } from "./file-tree.js";
import { handleFilesChanged } from "./files-changed.js";
import { handleFullResetComplete } from "./full-reset-complete.js";
import { handleGithubStatus } from "./github-status.js";
import { handleGitCommitted } from "./git-committed.js";
import { handleGitIdentityRequired } from "./git-identity-required.js";
import { handleGitLog } from "./git-log.js";
import { handleGitPushRejected } from "./git-push-rejected.js";
import { handleGlobalSettings } from "./global-settings.js";
import { handleInstallLog } from "./install-log.js";
import { handleInstallStatus } from "./install-status.js";
import { handleLogEntry } from "./log-entry.js";
import { handleMcpServerStatus } from "./mcp-server-status.js";
import { handleMessageQueued } from "./message-queued.js";
import { handleMessageSteered } from "./message-steered.js";
import { handleModelInfo } from "./model-info.js";
import { handlePrLifecycleUpdate } from "./pr-lifecycle-update.js";
import { handlePreviewError } from "./preview-error.js";
import { handlePreviewStatus } from "./preview-status.js";
import { handleQueueUpdated } from "./queue-updated.js";
import { handleRebaseAborted } from "./rebase-aborted.js";
import { handleRebaseComplete } from "./rebase-complete.js";
import { handleRebaseConflicts } from "./rebase-conflicts.js";
import { handleRebaseStarted } from "./rebase-started.js";
import { handleReviewUpdated } from "./review-updated.js";
import { handleRewindComplete } from "./rewind-complete.js";
import { handleRollbackComplete } from "./rollback-complete.js";
import { handleSecretsStatus } from "./secrets-status.js";
import { handleServiceList } from "./service-list.js";
import { handleServiceLog } from "./service-log.js";
import { handleServiceStatus } from "./service-status.js";
import { handleSessionForked } from "./session-forked.js";
import { handleSessionMemoryExhausted } from "./session-memory-exhausted.js";
import { handleSessionSpawned } from "./session-spawned.js";
import { handleSessionStarted } from "./session-started.js";
import { handleSessionStatus } from "./session-status.js";
import { handleSystemNotice } from "./system-notice.js";
import { handleSystemUserMessage } from "./system-user-message.js";
import { handleTemplateApplied } from "./template-applied.js";
import { handleTerminalExit } from "./terminal-exit.js";
import { handleTerminalOutput } from "./terminal-output.js";
import { handleTurnDiff } from "./turn-diff.js";
import { handleTurnUsageUpdate } from "./turn-usage-update.js";
import { handleUsageUpdate } from "./usage-update.js";

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
  agent_event: handleAgentEvent,
  agent_interrupted: handleAgentInterrupted,
  auth_required: handleAuthRequired,
  clear_logs: handleClearLogs,
  commit_linked: handleCommitLinked,
  compose_error: handleComposeError,
  compose_not_configured: handleComposeNotConfigured,
  container_restarting: handleContainerRestarting,
  error: handleError,
  file_tree: handleFileTree,
  files_changed: handleFilesChanged,
  full_reset_complete: handleFullResetComplete,
  git_committed: handleGitCommitted,
  git_identity_required: handleGitIdentityRequired,
  git_log: handleGitLog,
  git_push_rejected: handleGitPushRejected,
  github_status: handleGithubStatus,
  global_settings: handleGlobalSettings,
  install_log: handleInstallLog,
  install_status: handleInstallStatus,
  log_entry: handleLogEntry,
  mcp_server_status: handleMcpServerStatus,
  message_queued: handleMessageQueued,
  message_steered: handleMessageSteered,
  model_info: handleModelInfo,
  pr_lifecycle_update: handlePrLifecycleUpdate,
  preview_error: handlePreviewError,
  preview_status: handlePreviewStatus,
  queue_updated: handleQueueUpdated,
  rebase_aborted: handleRebaseAborted,
  rebase_complete: handleRebaseComplete,
  rebase_conflicts: handleRebaseConflicts,
  rebase_started: handleRebaseStarted,
  review_updated: handleReviewUpdated,
  rewind_complete: handleRewindComplete,
  rollback_complete: handleRollbackComplete,
  secrets_status: handleSecretsStatus,
  service_list: handleServiceList,
  service_log: handleServiceLog,
  service_status: handleServiceStatus,
  session_forked: handleSessionForked,
  session_memory_exhausted: handleSessionMemoryExhausted,
  session_spawned: handleSessionSpawned,
  session_started: handleSessionStarted,
  session_status: handleSessionStatus,
  system_notice: handleSystemNotice,
  system_user_message: handleSystemUserMessage,
  template_applied: handleTemplateApplied,
  terminal_exit: handleTerminalExit,
  terminal_output: handleTerminalOutput,
  turn_diff: handleTurnDiff,
  turn_usage_update: handleTurnUsageUpdate,
  usage_update: handleUsageUpdate,
};

/**
 * Dispatch a single WS server message to its handler (if any).
 *
 * Performs the discriminated-union narrowing here so handlers can be
 * typed precisely against their specific message variant without callers
 * having to know which key to index.
 */
export function dispatchMessage(ctx: HandlerContext, data: WsServerMessage): void {
  const handler = messageHandlers[data.type] as Handler | undefined;
  handler?.(ctx, data);
}

/** Create a fresh queued-message stash. See `QueuedMessageStash` doc. */
export function createQueuedMessageStash(): QueuedMessageStash {
  return new Map();
}
