import type { AgentId } from "./agent-types.js";

export type ProviderRouteKind = "account" | "reserved";

export type ProviderAccountStatus = "ready" | "authenticating" | "auth_failed" | "unavailable";

export interface ProviderAccountCapabilities {
  models?: string[];
  supportsImages?: boolean;
  supportsReview?: boolean;
  supportedPermissionModes?: string[];
  source: "provider_profile" | "agent_init" | "manual_default";
  refreshedAt: number;
}

export interface ProviderAccount {
  id: string;
  provider: AgentId;
  label: string;
  isPrimary: boolean;
  status: ProviderAccountStatus;
  plan?: string | null;
  capabilities?: ProviderAccountCapabilities;
  lastUsedAt?: number;
  exhaustedUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---- Runtime mode (feature 118) ----

/**
 * Runtime mode for the orchestrator.
 *
 *   - `containerized` (default): production mode. Each session gets a Docker
 *     container with a session-worker; agents run inside containers; compose
 *     stacks manage previews. Requires Docker.
 *   - `local`: dogfooding mode (ShipIt running inside ShipIt). No Docker
 *     containers are created for inner sessions; agent CLIs are spawned as
 *     in-process subprocesses; per-session inner-compose stacks are skipped.
 *     See docs/118-shipit-ui-local/plan.md.
 *
 * Defined here (shared types) so both the orchestrator and the React client
 * can reference it without the client reaching into orchestrator-only modules.
 * `app-di.ts` re-exports this symbol for back-compat with existing imports.
 *
 * NOTE: this is NOT the same as `isTestMode`. `isTestMode` means "test harness
 * with mocks"; `local` means "production behavior minus the container layer."
 */
export type RuntimeMode = "containerized" | "local";

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
  /**
   * docs/128 — server-authoritative session kind. Undefined means an ordinary
   * repo/local session. `"ops"` marks a privileged host-debugging session
   * created from the gated ops template: it gets read-only journal mounts and a
   * read-only Docker socket proxy. This field is set server-side at creation and
   * is NOT writable from inside the container, so an ordinary session can never
   * forge its way into the privileged mount path (the gate keys off `kind`, not
   * any workspace marker file).
   */
  kind?: "ops";
  createdAt: string;
  lastUsedAt: string;
  /** Per-session workspace directory, e.g. "/workspace/sessions/abc123". */
  workspaceDir?: string;
  /** Cached origin remote URL (e.g. "https://github.com/owner/repo.git"). */
  remoteUrl: string;
  /**
   * Back-compat alias for `userArchived` (docs/161): true when the user
   * explicitly hid the session from the sidebar. Derived, read-only — the
   * authoritative field is `userArchived`. Kept until all clients migrate.
   */
  archived?: boolean;
  /**
   * docs/161 — how much of the session is on disk right now. Orthogonal to
   * listing: a session can be listed in the sidebar while disk-evicted (it
   * restores on select) and fully on disk while not listed.
   *   - `hot`     — full checkout + node_modules + build artifacts.
   *   - `light`   — checkout (incl. uncommitted edits) kept; deps dropped.
   *   - `evicted` — workspace wiped; restore via clone-from-cache off fresh main.
   */
  diskTier?: "hot" | "light" | "evicted";
  /**
   * docs/161 — the explicit "hide this session" action. The only thing that
   * force-removes a session from the sidebar regardless of activity; reversible
   * from All Sessions. Distinct from `diskTier`: hiding never destroys disk and
   * disk reclamation never hides.
   */
  userArchived?: boolean;
  /**
   * docs/161 — bumped on viewer attach. Read ONLY by the disk-idle ladder
   * (`now - max(lastUsedAt, lastViewedAt)`); never by the listing predicate,
   * which keys off `lastUsedAt` so a merely-opened merged session isn't
   * promoted to Active forever.
   */
  lastViewedAt?: string;
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
  /**
   * When the session's PR was closed *without* being merged (abandoned/rejected).
   * The close analogue of `mergedAt`: like a merge, it's a terminal PR state that
   * sinks the session out of the active sidebar list into the "Recently resolved"
   * group. Kept distinct from `mergedAt` because closing is a different outcome
   * than merging (it does not delete the head branch or trigger merge-aware disk
   * reclaim, and the PR card badge stays red).
   */
  closedAt?: string;
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
   * docs/150 — route used for the pinned provider. Account routes refer to a
   * stored ProviderAccount id; reserved routes are env/API-key auth paths.
   */
  providerRouteKind?: ProviderRouteKind;
  providerRouteId?: string;
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
  /**
   * docs/178 — per-remote trust-on-first-use gate. `false` (the default for a
   * freshly-added remote) defers all repo-declared auto-execution
   * (agent.install + compose command:/build:) until the user accepts once via
   * `POST /api/repos/trust`. Clone, file tree, diffs, and agent chat still work
   * while untrusted. ShipIt-template repos are trusted at creation. Always
   * populated from the store; only omitted on hand-built RepoInfo literals.
   */
  trusted?: boolean;
}

// ---- Doc types ----

export interface DocEntry {
  /** Relative path from workspace root, e.g. "docs/001-websocket-protocol/plan.md". */
  path: string;
  /**
   * docs/168 — pointer to the issue that tracks this doc's work, taken
   * verbatim from the frontmatter `issue:` field. Work tracking lives in the
   * tracker, not the doc, so this is the doc's only link to its scheduling.
   * A Linear pointer is always a full URL
   * (`https://linear.app/<workspace>/issue/SHI-28/...`); a GitHub pointer is
   * `owner/repo#123` or a full issue URL. Absent on pure reference docs. The
   * tracker is inferred from the pointer's shape by the client.
   */
  issue?: string;
  /** Human-readable title. Derived from frontmatter `title:` field, or from filename. */
  title: string;
  /**
   * Short one-line summary from the frontmatter `description:` field. Rendered
   * under the title in the docs panel so a doc's purpose is legible without
   * opening it. Single-line only (trimmed); omitted when absent.
   */
  description?: string;
  /**
   * File mtime as ISO 8601 string. Retained for display/sorting, but NOT used
   * to decide "modified in this session" — git rewrites mtimes on checkout,
   * which produced false positives. See `changedInSession`.
   */
  modifiedAt?: string;
  /**
   * True when this doc was actually changed in the current session, as
   * determined server-side from git (committed branch changes since divergence
   * from the base branch, plus uncommitted edits). Authoritative replacement
   * for the old mtime-vs-session-start heuristic. Absent when git state could
   * not be resolved.
   */
  changedInSession?: boolean;
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

// ---- Issue tracker types (docs/170 — inline tracker Issues tab) ----

/**
 * Identifier for a configured issue tracker. Drives the Issues tab's sub-tab
 * switcher. v1 ships Linear only; `"github"` is reserved so a GitHub Issues
 * adapter can slot in later without a type change (see docs/170 non-goals).
 */
export type TrackerId = "linear" | "github";

/**
 * Normalized priority bucket, tracker-agnostic. Linear maps its 0–4 priority
 * field onto these; a future GitHub adapter can derive them from labels. The
 * Issues list sorts by `sortOrder` ascending (urgent first, none last).
 */
export type IssuePriorityLevel = "urgent" | "high" | "medium" | "low" | "none";

export interface IssuePriority {
  level: IssuePriorityLevel;
  /** Ascending sort key: urgent=0 … none=4. Drives the priority-sorted list. */
  sortOrder: number;
  /** Human label, e.g. "Urgent", "No priority". */
  label: string;
}

/** A single issue row returned by a tracker's `listIssues()`. */
export interface TrackerIssue {
  /** Tracker-internal node id (Linear GraphQL id). Used for `getIssue()`. */
  id: string;
  /** Human-facing identifier, e.g. "SHI-67". */
  identifier: string;
  title: string;
  /** Deep link to the issue in the tracker (escape hatch — not the happy path). */
  url: string;
  /** Issue body / description (markdown). Used to seed the session prompt. */
  description?: string;
  priority: IssuePriority;
  /** Workflow state, e.g. { name: "In Progress", type: "started" }. */
  status?: { name: string; type?: string };
  assignee?: { name: string; avatarUrl?: string };
  /**
   * Tracker-internal id of the current assignee (GitHub login, Linear
   * `assigneeId`), read straight from the raw API node — distinct from the
   * display-only `assignee` ({ name, avatarUrl }). Used to snapshot the prior
   * assignee for an undoable write so undo replays an exact id rather than
   * re-running the ambiguous name→id resolution (docs/177). Absent when
   * unassigned.
   */
  assigneeId?: string;
  /**
   * The states a `setStatus` may target on this tracker, surfaced on the read
   * path so the agent can pick a valid native name up front (docs/177). For
   * GitHub this is the fixed Open/Closed pair; for Linear it's the team's
   * workflow states. Absent on `listIssues` (only populated by `getIssue`).
   */
  availableStatuses?: { name: string; type?: string }[];
}

/** A comment created on an issue (docs/177 — agent issue writes). */
export interface TrackerComment {
  /** Tracker-internal comment id. Used to undo (delete) the comment. */
  id: string;
  /** Deep link to the comment, when the tracker returns one. */
  url?: string;
  /** The comment body that was posted. */
  body: string;
}

/** Which kind of issue write a provenance card records (docs/177). */
export type IssueWriteVerb = "comment" | "edit" | "status" | "assignee";

/**
 * The minimal snapshot a do-then-surface write captures so it can be undone as
 * a reverse brokered write (docs/177). Captured BEFORE mutating. The assignee
 * variant stores the prior **tracker-internal id** (GitHub login / Linear
 * `assigneeId`) so undo replays an exact id — never re-running the name→id
 * resolution that could be ambiguous.
 */
export type IssueWriteUndo =
  | { kind: "comment"; commentId: string }
  | { kind: "edit"; previousTitle?: string; previousDescription?: string }
  | { kind: "status"; previousStatus: string }
  | { kind: "assignee"; previousAssigneeId: string | null };

/** Undo lifecycle of a write provenance card. */
export type IssueWriteUndoState = "available" | "undoing" | "undone" | "failed";

/**
 * A do-then-surface provenance card recording an agent issue write (docs/177).
 * Shared verbatim by the live WS payload, the persisted chat-history row, and
 * the client card so the three can't drift (same pattern as the bug-report
 * card). The write has already happened by the time this exists; the card
 * surfaces it inline and offers Undo.
 */
export interface IssueWriteCard {
  /** Stable id — used to patch the card in place across its undo lifecycle. */
  cardId: string;
  tracker: TrackerId;
  /** Tracker-native id the undo reverse-write targets (number / key). */
  issueId: string;
  /** Display identifier, e.g. "SHI-28" or "owner/repo#42". */
  identifier: string;
  /** Issue title at write time, for the card line. */
  title: string;
  /** Deep link to the issue (escape hatch). */
  url?: string;
  verb: IssueWriteVerb;
  /** Human one-liner, e.g. "commented on SHI-28", "set #42 → Closed". */
  summary: string;
  /**
   * Whose identity the write is attributed to. GitHub writes use the acting
   * user's own token (`"user"`); Linear writes use the deployment-wide PAT, so
   * they are attributed to the workspace PAT owner (`"workspace"`), NOT the
   * acting user — the card must not claim per-user authorship for Linear.
   */
  attribution: "user" | "workspace";
  undo: IssueWriteUndo;
  undoState: IssueWriteUndoState;
  createdAt: string;
  /** Set when an undo attempt failed — shown on the card. */
  errorMessage?: string;
}

/**
 * docs/178 — a persisted "Context compacted" transcript card. Shared verbatim by
 * the live WS payload (`WsCompactionCard`), the persisted chat-history row
 * (`PersistedMessage.compaction`), and the client card so the three can't drift
 * (same pattern as the voice-note / bug-report / issue-write cards). Every detail
 * field is optional because Codex supplies none of them natively — the card
 * degrades to a bare "Context compacted" row when they're absent.
 */
export interface CompactionCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  id: string;
  /** `"manual"` for an explicit `/compact`, `"auto"` when the CLI self-compacted. */
  trigger?: "manual" | "auto";
  /** Context-window occupancy (tokens) before compaction. */
  preTokens?: number;
  /** Context-window occupancy (tokens) after compaction. */
  postTokens?: number;
  /** How long the compaction took, in ms, when the backend reports it. */
  durationMs?: number;
  createdAt: string;
}

/**
 * Per-tracker metadata + configuration state. Drives the sub-tab switcher and
 * the "Connect Linear" empty state. `configured` is false until the user has
 * supplied both an API token and a team binding.
 */
export interface TrackerInfo {
  id: TrackerId;
  label: string;
  configured: boolean;
  /** Bound workspace/team context, when configured (Linear team key/name). */
  binding?: { key: string; name: string };
}

/** Response shape for `GET /api/issues?tracker=...`. */
export interface ListIssuesResult {
  tracker: TrackerInfo;
  issues: TrackerIssue[];
}

/**
 * A pointer to a tracker issue used to seed a ShipIt session (docs/156 +
 * docs/170). The downstream `headless-sessions.create({ issueRef })` derives
 * the branch and the first agent prompt from this. Kept deliberately small so
 * both the in-app "Start session" path (pull, docs/170) and the future webhook
 * trigger (push, docs/156) can build one.
 */
export interface IssueRef {
  tracker: TrackerId;
  /** Human-facing identifier, e.g. "SHI-67" or "owner/repo#123". */
  identifier: string;
  title: string;
  url?: string;
  description?: string;
  /** Tracker-specific extras (e.g. Linear `agentSessionId`). */
  providerData?: Record<string, string>;
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
  /**
   * On-disk directory name. Usually equal to `name`, but some upstream catalog
   * plugins ship a directory whose frontmatter `name:` doesn't match the
   * folder. Callers that read SKILL.md from disk after a scan should prefer
   * `dirName` (falling back to `name` for older scanner output).
   */
  dirName?: string;
  /** One-line description from the skill's frontmatter, if present. */
  description?: string;
  /**
   * Where the skill comes from. "project" — scanned from the workspace
   * (`.claude/skills/**` or `.codex/skills/**`). "bundled" — a built-in
   * shipped by the active agent backend (e.g. Codex's `~/.codex/skills/**`).
   */
  source: "project" | "bundled";
}

// ---- Marketplace / plugin types (docs/149) ----

/**
 * Where a marketplace catalog is fetched from. v1 only seeds one source
 * (a `github` ref to `anthropics/claude-plugins-official`), but the
 * discriminated union is in place from day one so v2's "add a custom
 * marketplace" verb doesn't need a schema migration.
 */
export type MarketplaceSource =
  | { kind: "github"; ownerRepo: string; ref?: string }
  | { kind: "git";    url: string;      ref?: string }
  | { kind: "local";  path: string }
  | { kind: "url";    url: string };

/** Per-marketplace catalog status, surfaced in the Discover tab. */
export type MarketplaceStatus = "ok" | "fetch-failed" | "loading";

/**
 * Metadata about a single catalog (e.g. `claude-plugins-official`). Lives in
 * `marketplaces` SQLite table; v1 ships with one row pre-seeded.
 */
export interface MarketplaceInfo {
  id: string;
  source: MarketplaceSource;
  agentId: AgentId;
  autoUpdate: boolean;
  status: MarketplaceStatus;
  lastFetchedAt?: string;
  /** When set, the catalog clone failed and this is the surfaced error. */
  fetchError?: string;
}

/** A skill bundled inside a plugin. v3 adds richer ref types alongside this. */
export interface SkillRef {
  /**
   * Invocable name from the SKILL.md frontmatter `name:` field. This is what
   * the user types after `/` (Claude) or `$` (Codex) and what's preserved in
   * the install target's frontmatter as `<plugin>:<name>`.
   */
  name: string;
  /**
   * On-disk directory name inside the source plugin's `skills/` folder.
   * Usually equal to `name`, but upstream catalogs sometimes ship a directory
   * whose frontmatter `name:` doesn't match (e.g. `skills/writing-rules/`
   * with `name: writing-hookify-rules`). Used for source path lookups when
   * reading SKILL.md from the marketplace cache; `name` is used everywhere
   * user-facing.
   */
  dirName?: string;
  /** First line of the SKILL.md frontmatter `description`, if present. */
  description?: string;
}

/**
 * A plugin entry parsed from a marketplace's `marketplace.json`. v1 only
 * surfaces plugins whose source is an in-repo relative path AND that contain
 * at least one `skills/<name>/SKILL.md` — those are installable as a simple
 * file copy without secondary fetches. External plugins and plugins without
 * skills are filtered out for v1 (deferred to v2/v3 — see docs/149 plan).
 */
export interface PluginInfo {
  marketplaceId: string;
  name: string;
  description?: string;
  author?: string;
  category?: string;
  homepage?: string;
  /** Skills the plugin will install into `.claude/skills/<plugin>__<skill>/`. */
  skills: SkillRef[];
  /** Rough sum of skill `SKILL.md` byte sizes — the v1 "context cost" proxy. */
  estimatedContextBytes: number;
  /** Optional commit SHA the catalog pins this plugin to (for v3 diffs). */
  pinnedSha?: string;
  /** ISO timestamp of the catalog's last update (used in cards if present). */
  lastUpdated?: string;
}

/**
 * Recorded next to every ShipIt-managed skill directory as
 * `.shipit-installed.json`. Used to differentiate ShipIt-installed skills
 * from hand-written ones (collision detection, safe uninstall, upgrade hash
 * check). Hand-written skills have no marker and are off-limits to the
 * install flow.
 */
export interface InstallMarker {
  marketplaceId: string;
  pluginName: string;
  /** Catalog's pinned SHA at install time, or `"head"` when none was pinned. */
  version: string;
  installedAt: string;
  /** sha256 of `SKILL.md` at install time. Upgrade refuses if it diverged. */
  skillMdHash: string;
}

/**
 * One row of the Installed sub-tab. v1 lists ShipIt-managed installs only;
 * hand-written skills are surfaced in the composer's `/`-autocomplete (doc 138)
 * instead.
 */
export interface InstalledPluginInfo {
  marketplaceId: string;
  pluginName: string;
  skillName: string;
  version: string;
  installedAt: string;
  /** Filesystem path of the installed `<plugin>__<skill>/` directory. */
  directory: string;
}

/** Returned from `installPlugin()` so the client can refresh + report status. */
export interface InstallResult {
  /** The directories written under `.claude/skills/` (one per skill). */
  installedDirs: string[];
  /** Auto-commit hash. `null` when nothing was committed (e.g. no-op upgrade). */
  commitHash: string | null;
  /** Token convention for the install confirmation toast. */
  invocationTokens: string[];
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

/**
 * A selection-anchored comment inside a markdown file review. The comment is
 * anchored to a specific run of text the user highlighted; `contextBefore` and
 * `contextAfter` are small windows of surrounding text used to disambiguate
 * when the same `quotedText` appears multiple times in the document. When the
 * doc drifts so that `quotedText` can no longer be located, the comment is
 * rendered as orphaned rather than silently re-anchored to the wrong place.
 */
export interface SelectionReviewComment {
  id: string;
  kind: "selection";
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
  source: ReviewCommentSource;
}

export type ReviewComment = LineReviewComment | SelectionReviewComment;

// ---- Agent review types (docs/151 — agent review cards) ----

/** A line-anchored finding inside an immutable agent review snapshot. */
export interface AgentReviewLineComment {
  id: string;
  kind: "line";
  line: number;
  text: string;
}

/** A selection-anchored finding inside an immutable agent review snapshot. */
export interface AgentReviewSelectionComment {
  id: string;
  kind: "selection";
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
}

export type AgentReviewComment =
  | AgentReviewLineComment
  | AgentReviewSelectionComment;

/**
 * An immutable record of one subagent review of one file. Owns a snapshot of
 * the file contents at review time so anchors stay aligned with what the
 * reviewer saw, regardless of how the live file evolves afterward. There is
 * no draft phase, no status, and no send affordance — the row is created
 * complete and never mutated.
 */
export interface AgentReview {
  id: string;
  sessionId: string;
  filePath: string;
  fileType: FileReviewType;
  /** The file contents the reviewer saw. Anchors index into this string. */
  snapshotContent: string;
  /** SHA-256 of `snapshotContent`. */
  snapshotHash: string;
  /** Optional one-line takeaway from the subagent. */
  summary?: string;
  comments: AgentReviewComment[];
  createdAt: string;
}

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

/** Release channel an instance tracks. See docs/162-release-channels. */
export type ReleaseChannel = "stable" | "edge";

/**
 * Human-facing version identity of the running instance, channel-aware.
 * On `stable` this is the exact release tag (e.g. `v1.4.0`); on `edge` it is
 * `main @ <short-sha>`. Distinct from {@link SystemInfo.buildId}, which stays
 * the raw SHA used for client cache-busting.
 */
export interface VersionInfo {
  channel: ReleaseChannel;
  /** `vX.Y.Z` on a stable release, else `main @ <short-sha>`. */
  version: string;
  /** Full commit SHA the instance is built from, when resolvable. */
  commit?: string;
  /**
   * True when the on-disk checkout HEAD differs from the running image's baked
   * commit — the signature of an interrupted/failed in-place update where the
   * checkout advanced but the image was never rebuilt. The UI flags it so the
   * mismatch reads as "an update didn't finish" rather than a UI glitch.
   */
  mismatch?: boolean;
}

/**
 * Static per-process metadata about the orchestrator. Sent once on SSE
 * connect; the client uses `processStartedAt` to render a live-ticking
 * uptime badge so the user can confirm a restart actually bounced the
 * orchestrator (the value will reset on a fresh process).
 */
export interface SystemInfo {
  /** Epoch milliseconds when the orchestrator process started. */
  processStartedAt: number;
  /**
   * Build identifier for the orchestrator/client bundle. In production this is
   * passed as SHIPIT_BUILD_ID at image build time; in development it falls back
   * to the current git commit SHA.
   */
  buildId?: string;
  /**
   * Channel-aware human-facing version of the running instance. Surfaced in
   * Settings → Advanced → Software Updates so the user sees "Stable · v1.4.0"
   * or "Edge · main @ abc1234" instead of a bare SHA.
   */
  version?: VersionInfo;
  /**
   * Whether the host has an out-of-process updater/restarter watching the
   * trigger files. VPS installs set this to "managed"; local Docker prod is
   * "manual" and applies updates by re-running docker/local/prod.sh.
   */
  updateMode?: "managed" | "manual";
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
  notice?: boolean;
  noticeLevel?: "info" | "warn";
  rolledBack?: boolean;
  forkChild?: { childSessionId: string; title: string; branch: string };
  codeRollbackHash?: string;
  /**
   * Events emitted by subagents (Claude's Task tool) under any tool in this
   * message's `toolUse`. The client groups these by `parentToolUseId` and
   * renders them as a nested tree (109 — subagent transparency).
   */
  subagentEvents?: WsSubagentEvent[];
}

// ---- Ops session host overview (docs/128) ----

/** One ShipIt-managed container as seen by the orchestrator's Docker client. */
export interface HostContainerInfo {
  /** Short (12-char) container id. */
  id: string;
  /** Container name(s), leading slash stripped. */
  name: string;
  image: string;
  /** Docker state: running | exited | restarting | paused | created | dead. */
  state: string;
  /** Human status, e.g. "Up 3 hours" / "Exited (137) 2 minutes ago". */
  status: string;
  /** Unix seconds the container was created. */
  createdAt: number;
  /** Owning session id, when the container carries the shipit-session-id label. */
  sessionId?: string;
  /** Owning session title, resolved from the session store. */
  sessionTitle?: string;
  /** True when an agent turn is currently running for the owning session. */
  agentRunning?: boolean;
}

/**
 * Read-only host snapshot rendered inline in the ops session's Host tab. Built
 * from the orchestrator's own Docker client (it runs on the host), NOT from the
 * agent container. Informational only — no control actions (docs/128 §5).
 */
export interface HostOverview {
  generatedAt: string;
  /** False when the orchestrator's Docker client couldn't be reached. */
  dockerAvailable: boolean;
  /** Total / running counts across all ShipIt-managed containers. */
  totals: { containers: number; running: number };
  containers: HostContainerInfo[];
}
