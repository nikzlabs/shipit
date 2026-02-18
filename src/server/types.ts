// ---- Agent types (multi-agent support) ----

export type { AgentId, AgentCapabilities, AgentEvent, AgentInitEvent, AgentAssistantEvent, AgentToolResultEvent, AgentResultEvent, AgentContentBlock, AgentProcess, AgentRunParams } from "./agents/agent-process.js";

// ---- Claude CLI NDJSON event types ----

export interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
  model?: string;
}

export interface ClaudeContentBlockText {
  type: "text";
  text: string;
}

export interface ClaudeContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ClaudeContentBlock = ClaudeContentBlockText | ClaudeContentBlockToolUse;

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    content: ClaudeContentBlock[];
  };
}

export interface ClaudeUserEvent {
  type: "user";
  message: {
    content: unknown[];
  };
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  total_cost_usd?: number;
  duration_ms?: number;
  result?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;

// ---- Git types ----

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

// ---- Session types ----

export interface SessionInfo {
  id: string;
  /** Agent's conversation ID (e.g. Claude CLI session_id for --resume). */
  agentSessionId?: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  /** Per-session workspace directory, e.g. "/workspace/sessions/abc123". */
  workspaceDir?: string;
  /** Cached origin remote URL (e.g. "https://github.com/owner/repo.git"). */
  remoteUrl?: string;
  /** Whether this session has been archived (hidden from sidebar). */
  archived?: boolean;
}

// ---- Feature types ----

export type FeatureStatus = "planned" | "in-progress" | "done" | "paused";

export interface FeatureInfo {
  /** Directory name, e.g. "001-websocket-protocol". */
  id: string;
  /** Numeric prefix extracted from the directory name. */
  number: number;
  /** Human-readable name derived from the directory name. */
  name: string;
  /** Current status from YAML frontmatter. Defaults to "planned". */
  status: FeatureStatus;
  /** Relative path to plan.md from workspace root. */
  planPath: string;
  /** Relative path to checklist.md if it exists. */
  checklistPath?: string;
}

// ---- Template types ----

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;
  files: Record<string, string>;
}

// ---- WebSocket message types (client ↔ server) ----

export interface ImageAttachment {
  data: string;       // base64-encoded image data
  mediaType: string;  // "image/png", "image/jpeg", etc.
  filename?: string;  // optional original filename
}

export interface FileAttachment {
  /** Relative path within the workspace (e.g., "src/utils/format.ts"). */
  path: string;
  /** Full file content at the time of attachment. */
  content: string;
  /** Optional line range — if the user selected specific lines. */
  startLine?: number;
  endLine?: number;
}

export type PermissionMode = "auto" | "plan" | "normal";

export interface FileContextRef {
  /** Relative path within the workspace. */
  path: string;
}

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

export interface WsGetGitLog {
  type: "get_git_log";
}

export interface WsRollback {
  type: "rollback";
  commitHash: string;
}

export interface WsListSessions {
  type: "list_sessions";
}

export interface WsNewSession {
  type: "new_session";
}

export interface WsArchiveSession {
  type: "archive_session";
  sessionId: string;
}

export interface WsRenameSession {
  type: "rename_session";
  sessionId: string;
  title: string;
}

export interface WsListDocs {
  type: "list_docs";
}

export interface WsGetDoc {
  type: "get_doc";
  path: string;
}

export interface WsGetChatHistory {
  type: "get_chat_history";
  sessionId: string;
}

export interface WsGetFileTree {
  type: "get_file_tree";
}

export interface WsGetFileContent {
  type: "get_file_content";
  path: string;
}

export interface WsAnswerQuestion {
  type: "answer_question";
  toolUseId: string;
  answers: Record<string, string>;
}

export interface WsListTemplates {
  type: "list_templates";
}

export interface WsApplyTemplate {
  type: "apply_template";
  templateId: string;
}

// ---- GitHub auth client messages ----

export interface WsGitHubDeviceAuthStart {
  type: "github_device_auth_start";
}

export interface WsGitHubSetToken {
  type: "github_set_token";
  token: string;
}

export interface WsGitHubGetStatus {
  type: "github_get_status";
}

export interface WsGitHubPush {
  type: "github_push";
  remote?: string;
  branch?: string;
}

export interface WsGitHubPull {
  type: "github_pull";
  remote?: string;
  branch?: string;
}

export interface WsGitHubSetRemote {
  type: "github_set_remote";
  name: string;
  url: string;
}

export interface WsGitHubGetRemotes {
  type: "github_get_remotes";
}

export interface WsGitHubLogout {
  type: "github_logout";
}

export interface WsGitHubCreateRepo {
  type: "github_create_repo";
  name: string;
  description?: string;
  isPrivate?: boolean;
}

export interface WsGitHubCreatePR {
  type: "github_create_pr";
  title: string;
  body: string;
  base: string;
  draft?: boolean;
}

export interface WsGitHubListBranches {
  type: "github_list_branches";
}

// ---- GitHub import messages ----

export interface WsGitHubImportRepo {
  type: "github_import_repo";
  /** Full clone URL or "owner/repo" shorthand. */
  url: string;
  /** Optional branch to check out. Defaults to repo's default branch. */
  branch?: string;
}

export interface WsGitHubSearchRepos {
  type: "github_search_repos";
  query: string;
}

// ---- Home screen messages ----

export interface WsHomeCreateRepoWithTemplate {
  type: "home_create_repo_with_template";
  repoName: string;
  description?: string;
  isPrivate?: boolean;
  templateId: string;
}

export interface WsHomeSendWithRepo {
  type: "home_send_with_repo";
  repoUrl: string;
  text: string;
  images?: ImageAttachment[];
  files?: FileContextRef[];
  permissionMode?: PermissionMode;
}

// ---- AI PR description messages ----

export interface WsGeneratePRDescription {
  type: "generate_pr_description";
}

// ---- PR status & merge messages ----

export interface WsGetPrStatus {
  type: "get_pr_status";
}

export interface WsMergePr {
  type: "merge_pr";
  method?: "merge" | "squash" | "rebase";
}

// ---- Git identity messages ----

export interface WsSetGitIdentity {
  type: "set_git_identity";
  name: string;
  email: string;
}

export interface WsGitIdentityRequired {
  type: "git_identity_required";
}

export interface WsGitIdentitySet {
  type: "git_identity_set";
  name: string;
  email: string;
}

// ---- System prompt messages ----

export interface WsGetSystemPrompt {
  type: "get_system_prompt";
}

export interface WsSetSystemPrompt {
  type: "set_system_prompt";
  content: string;
}

// ---- Thread & checkpoint messages ----

export interface WsCreateCheckpoint {
  type: "create_checkpoint";
  label?: string;
}

export interface WsForkThread {
  type: "fork_thread";
  checkpointId: string;
}

export interface WsSwitchThread {
  type: "switch_thread";
  threadId: string;
}

export interface WsListThreads {
  type: "list_threads";
}

// ---- Feature client messages ----

export interface WsListFeatures {
  type: "list_features";
}

export interface WsSetApiKey {
  type: "set_api_key";
  key: string;
}

export interface WsPasteAuthCode {
  type: "paste_auth_code";
  code: string;
}

export type WsClientMessage =
  | WsSendMessage
  | WsGetGitLog
  | WsRollback
  | WsListSessions
  | WsNewSession
  | WsArchiveSession
  | WsRenameSession
  | WsListDocs
  | WsGetDoc
  | WsGetChatHistory
  | WsGetFileTree
  | WsGetFileContent
  | WsClearLogs
  | WsPreviewError
  | WsGetUsageStats
  | WsAnswerQuestion
  | WsListTemplates
  | WsApplyTemplate
  | WsGetSystemPrompt
  | WsSetSystemPrompt
  | WsGitHubDeviceAuthStart
  | WsGitHubSetToken
  | WsGitHubGetStatus
  | WsGitHubPush
  | WsGitHubPull
  | WsGitHubSetRemote
  | WsGitHubGetRemotes
  | WsGitHubLogout
  | WsGitHubCreateRepo
  | WsGitHubCreatePR
  | WsGitHubListBranches
  | WsSetGitIdentity
  | WsCreateCheckpoint
  | WsForkThread
  | WsSwitchThread
  | WsListThreads
  | WsSetApiKey
  | WsPasteAuthCode
  | WsListFeatures
  | WsGitHubImportRepo
  | WsGitHubSearchRepos
  | WsGeneratePRDescription
  | WsGetPrStatus
  | WsMergePr
  | WsListDeployTargets
  | WsDeployConfigure
  | WsInitiateDeploy
  | WsGetDeployHistory
  | WsGetDeployConfig
  | WsCancelDeploy
  | WsDeleteDeployConfig
  | WsTerminalStart
  | WsTerminalInput
  | WsTerminalResize
  | WsHomeCreateRepoWithTemplate
  | WsHomeSendWithRepo
  | WsSetAgentMessage;

export interface WsClaudeEvent {
  type: "claude_event";
  event: ClaudeEvent;
}

export interface WsAgentEvent {
  type: "agent_event";
  event: import("./agents/agent-process.js").AgentEvent;
}

export interface WsSetAgentMessage {
  type: "set_agent";
  agentId: import("./agents/agent-process.js").AgentId;
}

export interface WsError {
  type: "error";
  message: string;
}

export interface WsPreviewStatus {
  type: "preview_status";
  running: boolean;
  port: number;
  url: string;
  /** How the preview server was identified: "vite" (managed), "detected" (port scan), or omitted. */
  source?: "vite" | "detected";
  /** All ports detected by the port scanner (non-Vite dev servers). */
  detectedPorts?: number[];
}

export interface WsGitLog {
  type: "git_log";
  commits: GitCommitInfo[];
}

export interface WsGitCommitted {
  type: "git_committed";
  hash: string;
  message: string;
}

export interface WsRollbackComplete {
  type: "rollback_complete";
  commitHash: string;
}

// ---- Auth types ----

export interface WsAuthRequired {
  type: "auth_required";
  url?: string;
}

export interface WsAuthComplete {
  type: "auth_complete";
}

export interface WsSessionList {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface WsSessionStarted {
  type: "session_started";
  session: SessionInfo;
}

export interface WsSessionRenamed {
  type: "session_renamed";
  session: SessionInfo;
}

export interface WsDocList {
  type: "doc_list";
  files: string[];
}

export interface WsDocContent {
  type: "doc_content";
  path: string;
  content: string;
}

export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: Array<{
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  images?: Array<{
    data: string;      // base64 image data (inlined for small images)
    mediaType: string;
  }>;
  files?: Array<{
    path: string;
    contentPreview: string;  // first 200 chars of content
    startLine?: number;
    endLine?: number;
  }>;
  isError?: boolean;
}

export interface WsChatHistory {
  type: "chat_history";
  sessionId: string;
  messages: WsChatHistoryMessage[];
}

// ---- File tree types ----

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export interface WsFileTree {
  type: "file_tree";
  tree: FileTreeNode[];
}

export interface WsFileContent {
  type: "file_content";
  path: string;
  content: string;
  /** When true, the file is binary and `content` contains a human-readable message instead of file data. */
  isBinary?: boolean;
}

// ---- Usage tracking types ----

export interface UsageTurn {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SessionUsage {
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
}

export interface UsageStats {
  sessions: SessionUsage[];
  totalCostUsd: number;
  totalTurns: number;
}

// ---- Interactive terminal types (client → server) ----

export interface WsTerminalStart {
  type: "terminal_start";
}

export interface WsTerminalInput {
  type: "terminal_input";
  data: string;
}

export interface WsTerminalResize {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

// ---- Interactive terminal types (server → client) ----

export interface WsTerminalOutput {
  type: "terminal_output";
  data: string;
}

export interface WsTerminalExit {
  type: "terminal_exit";
  exitCode: number | null;
}

// ---- Terminal/logs types ----

export interface WsLogEntry {
  type: "log_entry";
  /** Where the log line originated. */
  source: "stderr" | "stdout" | "server" | "preview" | "deploy";
  text: string;
  timestamp: string;
}

export interface WsClearLogs {
  type: "clear_logs";
}

export interface WsPreviewError {
  type: "preview_error";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
}

// ---- Usage tracking messages ----

export interface WsGetUsageStats {
  type: "get_usage_stats";
}

export interface WsUsageStats {
  type: "usage_stats";
  stats: UsageStats;
}

export interface WsUsageUpdate {
  type: "usage_update";
  sessionId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  turnCount: number;
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
  cumulativeInputTokens?: number;
}

/** Sent once after the Claude CLI init event, and on reconnect. */
export interface WsModelInfo {
  type: "model_info";
  model: string;
  contextWindowTokens: number;
}

export interface WsTemplateList {
  type: "template_list";
  templates: Array<Omit<ProjectTemplate, "files">>;
}

export interface WsTemplateApplied {
  type: "template_applied";
  templateId: string;
  name: string;
}

// ---- GitHub auth server messages ----

export interface WsGitHubDeviceAuthCode {
  type: "github_device_auth_code";
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface WsGitHubDeviceAuthResult {
  type: "github_device_auth_result";
  success: boolean;
  message?: string;
}

export interface WsGitHubStatus {
  type: "github_status";
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface WsGitHubPushResult {
  type: "github_push_result";
  success: boolean;
  message: string;
  branch?: string;
}

export interface WsGitHubPullResult {
  type: "github_pull_result";
  success: boolean;
  message: string;
}

export interface WsGitHubRemotes {
  type: "github_remotes";
  remotes: Array<{ name: string; url: string }>;
}

export interface WsGitHubRepoCreated {
  type: "github_repo_created";
  success: boolean;
  name?: string;
  fullName?: string;
  url?: string;
  cloneUrl?: string;
  message?: string;
}

export interface WsGitHubPRCreated {
  type: "github_pr_created";
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
}

export interface WsGitHubBranches {
  type: "github_branches";
  current: string;
  remote: string[];
}

// ---- GitHub import server messages ----

export interface WsGitHubImportProgress {
  type: "github_import_progress";
  stage: "cloning" | "installing" | "ready";
  message: string;
}

export interface WsGitHubImportComplete {
  type: "github_import_complete";
  success: boolean;
  sessionId?: string;
  message?: string;
}

export interface WsGitHubSearchResults {
  type: "github_search_results";
  repos: Array<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>;
}

// ---- Home screen server messages ----

export interface WsHomeRepoReady {
  type: "home_repo_ready";
  success: boolean;
  repoUrl?: string;
  sessionId?: string;
  message?: string;
}

// ---- AI PR description server messages ----

export interface WsGeneratedPRDescription {
  type: "generated_pr_description";
  description: string;
}

// ---- PR status & merge server messages ----

export interface WsPrStatus {
  type: "pr_status";
  pr: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: {
      state: "pending" | "success" | "failure" | "none";
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
    autoMergeEnabled: boolean;
    mergeable: boolean;
  } | null;
}

export interface WsMergePrResult {
  type: "merge_pr_result";
  success: boolean;
  message: string;
  autoMergeEnabled?: boolean;
}

// ---- Feature server messages ----

export interface WsFeatureList {
  type: "feature_list";
  features: FeatureInfo[];
}

// ---- System prompt server messages ----

export interface WsSystemPrompt {
  type: "system_prompt";
  content: string;
}

export interface WsSystemPromptSaved {
  type: "system_prompt_saved";
  content: string;
}

// ---- Thread & checkpoint server messages ----

export interface CheckpointInfo {
  id: string;
  sessionId: string;
  messageIndex: number;
  commitHash: string;
  createdAt: string;
  label?: string;
}

export interface ThreadInfo {
  id: string;
  sessionId: string;
  parentCheckpointId: string | null;
  agentSessionId?: string;
  name: string;
  checkpoints: CheckpointInfo[];
  isActive: boolean;
  createdAt: string;
  /** When set, contains a conversation replay to use as system prompt on the first message. */
  conversationReplay?: string;
}

export interface WsCheckpointCreated {
  type: "checkpoint_created";
  checkpoint: CheckpointInfo;
  threadId: string;
}

export interface WsThreadList {
  type: "thread_list";
  threads: ThreadInfo[];
  activeThreadId: string;
}

export interface WsThreadSwitched {
  type: "thread_switched";
  thread: ThreadInfo;
  messages: WsChatHistoryMessage[];
}

export interface WsThreadForked {
  type: "thread_forked";
  thread: ThreadInfo;
  messages: WsChatHistoryMessage[];
}

// ---- File watcher types ----

export interface WsFilesChanged {
  type: "files_changed";
  /** Relative paths of files that changed in the workspace. */
  paths: string[];
}

// ---- Deployment types ----

export interface DeployTargetInfo {
  id: string;
  name: string;
  description: string;
  iconUrl?: string;
  configFields: ConfigField[];
  supportsPreview: boolean;
}

export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  sensitive: boolean;
  helpUrl?: string;
  helpText?: string;
  placeholder?: string;
}

export interface DeploymentRecord {
  id: string;
  targetId: string;
  environment: "production" | "preview";
  url: string;
  commitHash?: string;
  commitMessage?: string;
  timestamp: string;
  durationMs: number;
  status: "success" | "failed";
  error?: string;
}

// ---- Deployment client → server messages ----

export interface WsListDeployTargets {
  type: "list_deploy_targets";
}

export interface WsDeployConfigure {
  type: "deploy_configure";
  targetId: string;
  credentials: Record<string, string>;
  projectName?: string;
}

export interface WsInitiateDeploy {
  type: "initiate_deploy";
  targetId: string;
  environment?: "production" | "preview";
}

export interface WsGetDeployHistory {
  type: "get_deploy_history";
}

export interface WsGetDeployConfig {
  type: "get_deploy_config";
}

export interface WsCancelDeploy {
  type: "cancel_deploy";
}

export interface WsDeleteDeployConfig {
  type: "delete_deploy_config";
  targetId: string;
}

// ---- Deployment server → client messages ----

export interface WsDeployTargets {
  type: "deploy_targets";
  targets: DeployTargetInfo[];
}

export interface WsDeployConfigSaved {
  type: "deploy_config_saved";
  targetId: string;
}

export interface WsDeployConfigStatus {
  type: "deploy_config";
  targets: Record<string, { configured: boolean; projectName?: string }>;
}

export interface WsDeployStatus {
  type: "deploy_status";
  phase: "building" | "deploying" | "complete" | "error";
}

export interface WsDeployComplete {
  type: "deploy_complete";
  url: string;
  targetId: string;
  environment: "production" | "preview";
  durationMs: number;
}

export interface WsDeployError {
  type: "deploy_error";
  message: string;
  phase: "building" | "deploying";
}

export interface WsDeployHistory {
  type: "deploy_history";
  deployments: DeploymentRecord[];
}

export type WsServerMessage =
  | WsClaudeEvent
  | WsAgentEvent
  | WsError
  | WsPreviewStatus
  | WsGitLog
  | WsGitCommitted
  | WsRollbackComplete
  | WsAuthRequired
  | WsAuthComplete
  | WsSessionList
  | WsSessionStarted
  | WsSessionRenamed
  | WsDocList
  | WsDocContent
  | WsChatHistory
  | WsFileTree
  | WsFileContent
  | WsLogEntry
  | WsUsageStats
  | WsUsageUpdate
  | WsTemplateList
  | WsTemplateApplied
  | WsFeatureList
  | WsSystemPrompt
  | WsSystemPromptSaved
  | WsFilesChanged
  | WsGitHubDeviceAuthCode
  | WsGitHubDeviceAuthResult
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubPullResult
  | WsGitHubRemotes
  | WsGitHubRepoCreated
  | WsGitHubPRCreated
  | WsGitHubBranches
  | WsGitIdentityRequired
  | WsGitIdentitySet
  | WsCheckpointCreated
  | WsThreadList
  | WsThreadSwitched
  | WsThreadForked
  | WsDeployTargets
  | WsDeployConfigSaved
  | WsDeployConfigStatus
  | WsDeployStatus
  | WsDeployComplete
  | WsDeployError
  | WsDeployHistory
  | WsGitHubImportProgress
  | WsGitHubImportComplete
  | WsGitHubSearchResults
  | WsGeneratedPRDescription
  | WsPrStatus
  | WsMergePrResult
  | WsModelInfo
  | WsTerminalOutput
  | WsTerminalExit
  | WsHomeRepoReady;
