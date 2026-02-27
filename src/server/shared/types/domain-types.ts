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
  /** If this session is a worktree, the branch name. */
  branch?: string;
  /** Session type: "standalone" (default) or "worktree". */
  sessionType?: "standalone" | "worktree";
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

// ---- File tree types ----

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

// ---- Diff types ----

export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  binary: boolean;
  oldContent: string;
  newContent: string;
}

// ---- Chat history message (shared data type) ----

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
