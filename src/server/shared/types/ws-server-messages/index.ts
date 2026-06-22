import type {
  WsGitHubStatus,
  WsGitHubPushResult,
  WsGitHubRemotes,
  WsGitHubBranches,
  WsGitHubSearchResults,
  WsPrStatus,
  WsPrLifecycleUpdate,
  WsPrNotableFiles,
  WsResetEligible,
} from "../github-types.js";
import type { WsTerminalOutput, WsTerminalExit, WsTerminalReconnecting, WsLogSnapshot, WsLogAppend } from "../terminal-types.js";
import type { WsUsageStats, WsUsageUpdate, WsTurnUsageUpdate } from "../usage-types.js";

import type {
  WsAuthRequired,
  WsAgentAuthPending,
  WsAgentAuthComplete,
  WsAgentAuthFailed,
} from "./auth.js";
import type {
  WsAgentEvent,
  WsSubAgentSpawn,
  WsModelInfo,
  WsMessageQueued,
  WsQueueUpdated,
  WsMessageSteered,
  WsAgentListMessage,
  WsAgentInterrupted,
} from "./agent.js";
import type {
  WsGitLog,
  WsGitCommitted,
  WsGitIdentityRequired,
  WsGitIdentitySet,
  WsGitPushRejected,
  WsRebaseStarted,
  WsRebaseConflicts,
  WsRebaseComplete,
  WsRebaseAborted,
  WsAutoResolveStarted,
  WsAutoResolveResult,
} from "./git.js";
import type {
  WsInstallStatus,
  WsMcpServerStatus,
  WsInstallLog,
  WsServiceStatus,
  WsServiceList,
  WsComposeError,
  WsStackError,
  WsComposeNotConfigured,
  WsSecretsStatus,
  WsServiceOom,
} from "./service.js";
import type { WsDocList, WsDocContent, WsFileTree, WsFileContent, WsFilesChanged } from "./files.js";
import type { WsPreviewStatus, WsPreviewError } from "./preview.js";
import type {
  WsSessionList,
  WsSessionStarted,
  WsSessionRenamed,
  WsContainerRestarting,
  WsFullResetComplete,
  WsSessionStatus,
  WsSessionMemoryExhausted,
  WsSessionAgentStarted,
  WsSessionAgentFinished,
  WsSystemUserMessage,
  WsSystemNotice,
} from "./session.js";
import type { WsRepoStatus, WsRepoWarmReady, WsRepoList } from "./repo.js";
import type {
  WsCommitLinked,
  WsRewindComplete,
  WsRewindSnapshotAvailable,
  WsRewindRestored,
  WsRewindPreview,
  WsSessionForked,
  WsForkBreadcrumb,
} from "./rollback.js";
import type { WsSessionSpawned, WsSessionSpawnFailed, WsChildMergedCard } from "./spawn.js";
import type {
  WsPresentContentMessage,
  WsPresentClearedMessage,
  WsPresentStateMessage,
} from "./present.js";
import type {
  WsVoiceNote,
  WsBugReportCard,
  WsBugReportFiled,
  WsBugReportFailed,
  WsEgressPromptCard,
  WsEgressPromptResolved,
  WsPermissionRequestCard,
  WsPermissionResolved,
  WsIssueWriteCard,
  WsIssueWriteUpdate,
  WsIssueRefCard,
  WsCompactionStatus,
  WsCompactionCard,
  WsReleaseCard,
  WsSubAgentConsultCard,
  WsActionChecklistCard,
  WsBranchAutoResetCard,
} from "./cards.js";
import type {
  WsError,
  WsGlobalSettings,
  WsTemplateApplied,
  WsTurnDiff,
  WsSubscriptionLimits,
} from "./misc.js";

export * from "./auth.js";
export * from "./agent.js";
export * from "./git.js";
export * from "./service.js";
export * from "./files.js";
export * from "./preview.js";
export * from "./session.js";
export * from "./repo.js";
export * from "./rollback.js";
export * from "./spawn.js";
export * from "./present.js";
export * from "./cards.js";
export * from "./misc.js";

export type WsServerMessage =
  | WsAgentEvent
  | WsVoiceNote
  | WsCompactionStatus
  | WsCompactionCard
  | WsReleaseCard
  | WsSubAgentConsultCard
  | WsActionChecklistCard
  | WsBranchAutoResetCard
  | WsBugReportCard
  | WsBugReportFiled
  | WsBugReportFailed
  | WsEgressPromptCard
  | WsEgressPromptResolved
  | WsPermissionRequestCard
  | WsPermissionResolved
  | WsIssueWriteCard
  | WsIssueWriteUpdate
  | WsIssueRefCard
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsAuthRequired
  | WsAgentAuthPending
  | WsAgentAuthComplete
  | WsAgentAuthFailed
  | WsSessionList
  | WsSessionStarted
  | WsSessionRenamed
  | WsDocList
  | WsDocContent
  | WsFileTree
  | WsFileContent
  | WsLogSnapshot
  | WsLogAppend
  | WsUsageStats
  | WsUsageUpdate
  | WsTurnUsageUpdate
  | WsTemplateApplied
  | WsGlobalSettings
  | WsSubAgentSpawn
  | WsFilesChanged
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubRemotes
  | WsGitHubBranches
  | WsGitIdentityRequired
  | WsGitIdentitySet
  | WsGitHubSearchResults
  | WsPrStatus
  | WsModelInfo
  | WsTerminalOutput
  | WsTerminalExit
  | WsTerminalReconnecting
  | WsMessageQueued
  | WsQueueUpdated
  | WsMessageSteered
  | WsAgentListMessage
  | WsAgentInterrupted
  | WsContainerRestarting
  | WsFullResetComplete
  | WsTurnDiff
  | WsSessionStatus
  | WsSessionAgentStarted
  | WsSessionAgentFinished
  | WsRepoStatus
  | WsRepoWarmReady
  | WsRepoList
  | WsPrLifecycleUpdate
  | WsPrNotableFiles
  | WsResetEligible
  | WsSystemUserMessage
  | WsSystemNotice
  | WsCommitLinked
  | WsRewindComplete
  | WsRewindPreview
  | WsRewindSnapshotAvailable
  | WsRewindRestored
  | WsSessionForked
  | WsForkBreadcrumb
  | WsSessionSpawned
  | WsSessionSpawnFailed
  | WsChildMergedCard
  | WsServiceStatus
  | WsServiceList
  | WsServiceOom
  | WsSessionMemoryExhausted
  | WsPreviewError
  | WsComposeError
  | WsStackError
  | WsComposeNotConfigured
  | WsSecretsStatus
  | WsInstallStatus
  | WsInstallLog
  | WsMcpServerStatus
  | WsGitPushRejected
  | WsRebaseStarted
  | WsRebaseConflicts
  | WsRebaseComplete
  | WsRebaseAborted
  | WsAutoResolveStarted
  | WsAutoResolveResult
  | WsPresentContentMessage
  | WsPresentClearedMessage
  | WsPresentStateMessage
  | WsSubscriptionLimits;
