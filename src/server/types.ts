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
  title: string;
  createdAt: string;
  lastUsedAt: string;
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

export interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
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

export interface WsDeleteSession {
  type: "delete_session";
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

// ---- System prompt messages ----

export interface WsGetSystemPrompt {
  type: "get_system_prompt";
}

export interface WsSetSystemPrompt {
  type: "set_system_prompt";
  content: string;
}

export type WsClientMessage =
  | WsSendMessage
  | WsGetGitLog
  | WsRollback
  | WsListSessions
  | WsNewSession
  | WsDeleteSession
  | WsRenameSession
  | WsListDocs
  | WsGetDoc
  | WsGetChatHistory
  | WsGetFileTree
  | WsGetFileContent
  | WsClearLogs
  | WsGetUsageStats
  | WsAnswerQuestion
  | WsListTemplates
  | WsApplyTemplate
  | WsGetSystemPrompt
  | WsSetSystemPrompt
  | WsGitHubSetToken
  | WsGitHubGetStatus
  | WsGitHubPush
  | WsGitHubPull
  | WsGitHubSetRemote
  | WsGitHubGetRemotes
  | WsGitHubLogout
  | WsGitHubCreateRepo;

export interface WsClaudeEvent {
  type: "claude_event";
  event: ClaudeEvent;
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
  url: string;
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

// ---- Terminal/logs types ----

export interface WsLogEntry {
  type: "log_entry";
  /** Where the log line originated. */
  source: "stderr" | "stdout" | "server";
  text: string;
  timestamp: string;
}

export interface WsClearLogs {
  type: "clear_logs";
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

// ---- System prompt server messages ----

export interface WsSystemPrompt {
  type: "system_prompt";
  content: string;
}

export interface WsSystemPromptSaved {
  type: "system_prompt_saved";
  content: string;
}

export type WsServerMessage =
  | WsClaudeEvent
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
  | WsSystemPrompt
  | WsSystemPromptSaved
  | WsGitHubStatus
  | WsGitHubPushResult
  | WsGitHubPullResult
  | WsGitHubRemotes
  | WsGitHubRepoCreated;
