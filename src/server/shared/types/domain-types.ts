import type { AgentId } from "./agent-types.js";

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
  /** Agent (provider) selected for this session. Locked in on first WS connect. */
  agentId?: AgentId;
  /**
   * docs/138 — true once the session has taken its first turn. At that point
   * the agent is fixed for the session's life: its credentials have been
   * provisioned into the per-session credentials directory, the other agent's
   * credentials are deliberately absent, and `set_agent` is rejected.
   */
  agentPinned?: boolean;
  /**
   * If this session was spawned by another session via `shipit session create`
   * (see docs/117-agent-spawned-sessions/), the parent's session ID. Used to
   * render the sidebar grouping ("spawned by parent") and to scope the
   * agent-facing `shipit session view/message/archive` operations so a parent
   * agent can only touch sessions it actually spawned.
   */
  parentSessionId?: string;
  /**
   * Optional identifier of the turn that spawned this session (the parent's
   * message group id at spawn time). Lets us scope `shipit session list` to
   * "this turn first" without walking chat history. Free-form string; the
   * orchestrator does not interpret it beyond persistence.
   */
  spawnedByTurn?: string;
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

export type DocStatus = "planned" | "in-progress" | "done" | "paused" | "rejected";

/**
 * Priority hint for `planned` docs — used to answer "which planned feature is
 * up next?" Ignored for any other status. Optional; absence means "unset".
 */
export type DocPriority = "high" | "medium" | "low";

export interface DocEntry {
  /** Relative path from workspace root, e.g. "docs/001-websocket-protocol/plan.md". */
  path: string;
  /** Status from YAML frontmatter, if present and one of the known enum values.
   * Undefined when the frontmatter is absent OR when it carries an unrecognized
   * value (which is captured in `customStatus` instead). */
  status?: DocStatus;
  /**
   * Raw `status:` value from frontmatter when it isn't one of the known enum
   * values. Lowercased and trimmed. Lets us still consider the doc "tracked"
   * (the author clearly intended to label it) without leaking unrecognized
   * values into the closed enum used for UI bucketing.
   */
  customStatus?: string;
  /**
   * Priority from YAML frontmatter, only surfaced when `status === "planned"`.
   * Drives sort order in the docs viewer; otherwise advisory.
   */
  priority?: DocPriority;
  /** Human-readable title. Derived from frontmatter `title:` field, or from filename. */
  title: string;
  /**
   * Short one-line summary from the frontmatter `description:` field. Rendered
   * under the title in the docs panel so a doc's purpose is legible without
   * opening it. Single-line only (trimmed); omitted when absent.
   */
  description?: string;
  /**
   * File mtime as ISO 8601 string. Used by the client to surface docs that
   * were modified during the current session at the top of the docs tab.
   */
  modifiedAt?: string;
  /**
   * Checkbox progress aggregated from `- [ ]` / `- [x]` items at any
   * indentation level. For a tracked plan, this comes from its sibling
   * `checklist.md` so the docs panel can render an at-a-glance progress
   * badge next to the status badge. For a standalone checklist (no plan
   * sibling), it reflects that file's own counts. Omitted when the doc
   * has no associated checklist.
   */
  checklist?: { total: number; done: number };
}

// ---- Skill types ----

/**
 * A user-invocable skill that can be triggered at the start of a chat message
 * (`/name` on Claude, `$name` on Codex). Feeds the composer's `/` autocomplete
 * menu. See docs/138-skill-invocation.
 */
export interface SkillInfo {
  /** Invocable name, e.g. "my-skill" → `/my-skill` (Claude) or `$my-skill` (Codex). */
  name: string;
  /** One-line description from the skill's frontmatter, if present. */
  description?: string;
  /**
   * Where the skill comes from. "project" — scanned from the workspace
   * (`.claude/skills/**` or `.codex/skills/**`). "bundled" — a built-in
   * shipped by the active agent backend (e.g. Codex's `~/.codex/skills/**`).
   */
  source: "project" | "bundled";
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

// ---- Secret declaration types (087-reusable-preview-secrets) ----

/**
 * A secret declaration entry from `x-shipit-secrets` in docker-compose.yml.
 * Two surface forms are accepted; both normalize to `SecretRequirement` once
 * parsed.
 *
 *   x-shipit-secrets:
 *     - STRIPE_KEY                      # string shorthand
 *     - name: DATABASE_URL              # object form
 *       description: Postgres URL
 *       required: true
 *       agent: true
 *       source: platform:claude_oauth
 */
export type SecretEntry = string | SecretRequirement;

export interface SecretRequirement {
  /**
   * Env var name to inject into the service. Must match
   * `^[A-Za-z_][A-Za-z0-9_]*$`.
   */
  name: string;
  /**
   * Human-readable description shown to the user in the secrets UI when
   * prompted to configure a value. Free-form text.
   */
  description?: string;
  /**
   * If true, the service will not run successfully without a value. Drives
   * the `secrets_missing` warning UI and surfaces in the secrets panel as a
   * required-marker.
   */
  required?: boolean;
  /**
   * If true, this secret is also injected into the agent container (via
   * `--env-file .shipit/.env.agent`). Used for connection strings the agent
   * needs when running migrations / codegen / tests against the running
   * stack. (Phase 3.)
   */
  agent?: boolean;
  /**
   * Resolve the value from a platform source instead of user-saved secrets.
   * Recognized values:
   *   - "platform:claude_oauth" — Claude OAuth token from AuthManager
   *   - "platform:github_token" — GitHub token from GitHubAuthManager
   * Unknown sources fall through to user-saved secrets. (Phase 4.)
   */
  source?: string;
}

// ---- Docker memory stats ----

export interface DockerMemoryStats {
  /** Memory currently in use (bytes). */
  usedBytes: number;
  /** Memory limit (bytes). 0 means unlimited. */
  totalBytes: number;
}

// ---- System info ----

/**
 * Static per-process metadata about the orchestrator. Sent once on SSE
 * connect; the client uses `processStartedAt` to render a live-ticking
 * uptime badge so the user can confirm a restart actually bounced the
 * orchestrator (the value will reset on a fresh process).
 */
export interface SystemInfo {
  /** Epoch milliseconds when the orchestrator process started. */
  processStartedAt: number;
}

// ---- Chat history message (shared data type) ----

/**
 * A single nested event emitted by a subagent (Claude's Task tool). The
 * `parentToolUseId` links it back to a tool_use block in the parent message's
 * `toolUse` list. Used for subagent transparency (109).
 */
export type WsSubagentEvent =
  | {
      kind: "assistant";
      parentToolUseId: string;
      text: string;
      toolUse: {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[];
    }
  | {
      kind: "tool_result";
      parentToolUseId: string;
      toolResults: {
        toolUseId: string;
        content: string;
        isError?: boolean;
      }[];
    };

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
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The client groups these by `parentToolUseId` and
   * renders them as a nested tree (109 — subagent transparency).
   */
  subagentEvents?: WsSubagentEvent[];
}
