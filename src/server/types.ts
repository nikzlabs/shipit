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

export type WsClientMessage =
  | WsSendMessage
  | WsGetGitLog
  | WsRollback
  | WsListSessions
  | WsNewSession
  | WsDeleteSession
  | WsListDocs
  | WsGetDoc
  | WsGetChatHistory;

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
  | WsDocList
  | WsDocContent
  | WsChatHistory;
