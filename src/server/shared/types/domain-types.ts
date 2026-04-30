// ---- Git types ----

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
  refs: string[];
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
  remoteUrl: string;
  /** Whether this session has been archived (hidden from sidebar). */
  archived?: boolean;
  /** Branch name for sessions cloned from a repo. */
  branch?: string;
  /** If true, this is a pre-created warm session not yet visible in the sidebar. */
  warm?: boolean;
  /** True once the branch has been renamed with a descriptive slug after graduation. */
  branchRenamed?: boolean;
  /** Conversation replay text injected as system prompt context after a rollback. */
  conversationReplay?: string;
  /** When the session's PR was merged. Sessions with mergedAt are kept alive until pruned. */
  mergedAt?: string;
  /** Model alias or ID selected for this session (e.g., "sonnet", "opus", "gpt-5.4"). */
  model?: string;
}

// ---- Repo types ----

export interface RepoInfo {
  /** Canonical remote URL, e.g. "https://github.com/owner/repo.git". */
  url: string;
  /** When the repo was added. */
  addedAt: string;
  /** Last time any session was created for this repo. */
  lastUsedAt: string;
  /** Clone status. "cloning" while initial clone is in progress. */
  status: "cloning" | "ready";
  /** Session ID of the current warm (pre-created) session, if any. */
  warmSessionId?: string;
}

// ---- Doc types ----

export type DocStatus = "planned" | "in-progress" | "done" | "paused";

/**
 * Priority hint for `planned` docs — used to answer "which planned feature is
 * up next?" Ignored for any other status. Optional; absence means "unset".
 */
export type DocPriority = "high" | "medium" | "low";

export interface DocEntry {
  /** Relative path from workspace root, e.g. "docs/001-websocket-protocol/plan.md". */
  path: string;
  /** Status from YAML frontmatter, if present. Undefined for plain docs. */
  status?: DocStatus;
  /**
   * Priority from YAML frontmatter, only surfaced when `status === "planned"`.
   * Drives sort order in the docs viewer; otherwise advisory.
   */
  priority?: DocPriority;
  /** Human-readable title. Derived from frontmatter `title:` field, or from filename. */
  title: string;
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

// ---- Review comment types (unified surface, server-persisted per session/file) ----

export type ReviewCommentSource = "human" | "ai";

export type ReviewStatus = "draft" | "sent";

export type FileReviewType = "code" | "markdown";

/** A line-anchored comment inside a code file review. */
export interface LineReviewComment {
  id: string;
  kind: "line";
  line: number;
  text: string;
  source: ReviewCommentSource;
}

/** A section-anchored comment inside a markdown file review. */
export interface SectionReviewComment {
  id: string;
  kind: "section";
  sectionHeading: string;
  sectionIndex: number;
  text: string;
  source: ReviewCommentSource;
}

export type ReviewComment = LineReviewComment | SectionReviewComment;

/**
 * A review of a single file inside one session. Drafts collect comments
 * from the user (and optionally from AI Review); sending freezes the
 * draft and dispatches a structured prompt to the agent.
 */
export interface FileReview {
  id: string;
  sessionId: string;
  filePath: string;
  fileType: FileReviewType;
  status: ReviewStatus;
  comments: ReviewComment[];
  /** SHA-256 of the file content at the time the draft was created. */
  docSnapshotHash: string;
  /** For markdown reviews, ordered list of `## ` headings at snapshot time. */
  sectionHeadings: string[];
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

// ---- Legacy client-side file comment types (DiffPanel only) ----

/** Line-anchored comment used by DiffPanel for per-staged-change feedback. */
export interface LineComment {
  id: string;
  kind: "line";
  filePath: string;
  line: number;
  text: string;
}

/** Section-anchored comment kept only for legacy data shape compatibility. */
export interface SectionComment {
  id: string;
  kind: "section";
  filePath: string;
  sectionHeading: string;
  sectionIndex: number;
  text: string;
}

export type FileComment = LineComment | SectionComment;

// ---- Docker memory stats ----

export interface DockerMemoryStats {
  /** Memory currently in use (bytes). */
  usedBytes: number;
  /** Memory limit (bytes). 0 means unlimited. */
  totalBytes: number;
}

// ---- Chat history message (shared data type) ----

import type { TurnUsage } from "./usage-types.js";

export interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  images?: {
    data: string;      // base64 image data (inlined for small images)
    mediaType: string;
  }[];
  files?: {
    path: string;
    contentPreview: string;  // first 200 chars of content
    startLine?: number;
    endLine?: number;
  }[];
  isError?: boolean;
  toolResults?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  }[];
  /** True while the agent turn that produced this message is still running. */
  inProgress?: boolean;
  /** Git commit hash produced by auto-commit after this assistant message. */
  commitHash?: string;
  /** Parent commit hash (HEAD before the auto-commit). Used for rollback. */
  parentCommitHash?: string;
  /** Upload paths consumed by this message (for hydration of pending vs sent state). */
  uploadPaths?: string[];
  /** Per-turn usage for the agent turn that produced this message — only on the last group of a turn. */
  turnUsage?: TurnUsage;
}
