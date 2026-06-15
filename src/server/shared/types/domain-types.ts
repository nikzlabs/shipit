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

// ---- Egress settings (docs/172 / SHI-90) ----

/**
 * Global egress containment settings surfaced to the browser Settings panel.
 * `globalEnabled` is the default-on containment switch (true = Contained =
 * default-deny + allowlist + prompts; false = Open = unrestricted egress).
 * `globalHosts` is the user-managed allowlist (in addition to the built-in base
 * list, operator extras, and live MCP hosts).
 */
export interface EgressSettings {
  globalEnabled: boolean;
  globalHosts: string[];
}

/**
 * A session's egress view: the resolved containment plus its own override and
 * per-session extra hosts. `override` is `null` when the session inherits the
 * global switch, `true`/`false` when it forces Contained/Open.
 */
export interface EgressSessionSettings {
  sessionId: string;
  override: boolean | null;
  hosts: string[];
  /** Resolved containment after applying override over global. */
  effectiveContained: boolean;
  /** The current global switch, for rendering the "inherits global" state. */
  globalEnabled: boolean;
}

/**
 * Where an effective-allowlist entry comes from. Only the two `user-*` sources
 * are user-editable; the rest are derived and shown read-only so the editor can
 * explain *why* a host is reachable.
 *   - `builtin`      — the always-on base list (agent APIs, git host, registries).
 *   - `operator`     — the deployment's `SESSION_EGRESS_ALLOWLIST` env.
 *   - `mcp`          — a connected MCP server / OAuth provider host.
 *   - `user-global`  — added by the user via the Settings allowlist editor.
 *   - `user-session` — added by the user for one session (per-session override).
 */
export type EgressAllowlistSource = "builtin" | "operator" | "mcp" | "user-global" | "user-session";

/** One row of the effective allowlist, with provenance + whether it's removable. */
export interface EgressAllowlistEntry {
  host: string;
  source: EgressAllowlistSource;
  /** True only for `user-global` / `user-session` — built-ins/MCP/operator are read-only. */
  removable: boolean;
}

/**
 * The full effective-allowlist view for the Settings editor: every host the
 * session can reach (with provenance), the global containment toggle, and — when
 * a session is in scope — that session's override + resolved containment.
 */
export interface EgressAllowlistView {
  entries: EgressAllowlistEntry[];
  globalEnabled: boolean;
  /** The in-scope session's settings, or null for the global-only view. */
  session: EgressSessionSettings | null;
  /** True when the user has removed any built-in default (drives "Restore defaults"). */
  defaultsCustomized: boolean;
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
  /**
   * docs/110 — pinned session. ISO timestamp set when the user pins the session;
   * presence is the pin flag, the value orders pins (most-recently-pinned first)
   * within a repo group. A pin makes the session **persistent**: it sticks to the
   * top of its repo group in the sidebar, is exempt from the merged top-N view cap
   * (`filterVisibleInSidebar`) so it never silently drops out of the list, and is
   * immune to automatic disk-tier descent (`canAutoDescend`) so its workspace is
   * never reclaimed. Cleared by an explicit user archive — a session can't be both
   * hidden and persistent.
   */
  pinnedAt?: string;
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
  /**
   * docs/201 — the top-level ancestor of this session's spawn tree. A child can
   * itself spawn grandchildren; `parentSessionId` is single-step, so the sidebar
   * keys its grouping and merged-view-cap exemption off this ROOT instead — a
   * whole brood (children + grandchildren + deeper) groups under one top-level
   * session, and a descendant stays visible while its root is live regardless of
   * how deep it sits. Computed once at spawn (`parent.rootSessionId ?? parent.id`)
   * — no chain walking at read time. **Undefined on a top-level (user-created)
   * session**: it IS its own root, so `!!parentSessionId` stays the "am I
   * spawned?" test and only spawned descendants carry a root. `parentSessionId`
   * is retained alongside for true immediate lineage / provenance.
   */
  rootSessionId?: string;
  /**
   * docs/182 — true when the session's last completed turn ended in an error
   * (agent process error, or an `agent_result` carrying an error that wasn't a
   * deliberate interrupt). Persisted so it survives an orchestrator restart and
   * the child-session readiness check (`shipit session wait`) can report a
   * distinct `error` outcome instead of a false `idle`. Cleared (set false) on
   * the next clean turn completion.
   */
  lastTurnErrored?: boolean;
  /**
   * docs/186 — per-session pause for the auto-fix-CI loop. When true, the PR
   * poller's auto-fix loop is suppressed for THIS session even while the global
   * `autoFixCi` setting is on. Persisted on the session row so a pause survives
   * a restart. Undefined / false means the global setting governs. Toggled from
   * the PR card's overflow menu (only shown when the global setting is on).
   */
  autoFixCiPaused?: boolean;
  /**
   * docs/196 — async "notify parent when this child's PR merges" watch. Set on
   * the CHILD session row by `shipit session notify-on-merge`; the parent that
   * registered it is recorded in `parentSessionId` here. The PR poller fires the
   * watch when this session's PR reaches a terminal state (merged or
   * closed-without-merge), enqueuing a self-describing system turn into the
   * parent's message queue and surfacing a persisted merge card. Persisted so
   * the firing survives an orchestrator restart; the `state` machine
   * (`armed → merge-observed → delivered`, or terminal `closed-unmerged`) makes
   * delivery fire-once.
   */
  mergeWatch?: SessionMergeWatch;
  /**
   * docs/202 — display-only breadcrumb of the session's prior MERGED PR,
   * retained after a re-arm clears `merged_at`. Set by `clearMerged` when a
   * merged branch is rebased onto its base and gains genuinely new work, so the
   * session returns to Active/gray while still remembering it shipped once.
   *
   * Two non-display consumers piggyback on it, both deliberate:
   *   - `number` doubles as the PR poller's superseded-PR suppression key (so an
   *     immediate REST verify can't re-promote the OLD merged PR back to merged
   *     before the new PR opens), and
   *   - `baseBranch` targets the new PR's base + the "ready" diff, since re-arm
   *     is the one case where ShipIt knows the correct base (the prior PR's).
   *
   * It MUST NOT feed `resolvedAt()`, sidebar grouping, status color, or the
   * disk-eviction tier — clearing `merged_at` is what drives all of those, and
   * this breadcrumb is purely additive.
   */
  previousMergedPr?: PreviousMergedPr;
}

/**
 * docs/202 — lightweight reference to a session's prior merged PR, retained on
 * the session after re-arm. See `SessionInfo.previousMergedPr`.
 */
export interface PreviousMergedPr {
  number: number;
  url: string;
  title: string;
  /** The prior PR's base branch — the new PR targets the same base. */
  baseBranch: string;
}

/**
 * docs/196 — a single parent→child merge-watch, stored on the child session row.
 * The lifecycle is fire-once: a re-poll (or a restart-driven re-derivation) that
 * sees a terminal state but an already-`delivered`/`closed-unmerged` watch is a
 * no-op.
 */
export interface SessionMergeWatch {
  /** Session that registered the watch and receives the wake-turn + merge card. */
  parentSessionId: string;
  /**
   * - `armed` — registered, waiting for the child's PR to reach a terminal state
   *   (the PR need not exist yet).
   * - `merge-observed` — the poller saw the merge and surfaced the card, but the
   *   actionable wake-turn hasn't been enqueued into the parent yet (a transient
   *   step; re-tried on the next poll if enqueue couldn't complete).
   * - `delivered` — the merge wake-turn was enqueued. Terminal, fire-once.
   * - `closed-unmerged` — the PR closed without merging; a distinct wake-turn was
   *   enqueued so the parent doesn't proceed as if the work shipped. Terminal.
   */
  state: "armed" | "merge-observed" | "delivered" | "closed-unmerged";
  /** ISO instant the watch was armed. */
  registeredAt: string;
  /** ISO instant the terminal PR state was first observed. */
  observedAt?: string;
  /** ISO instant the wake-turn was enqueued into the parent. */
  deliveredAt?: string;
}

/**
 * docs/196 — payload for the inline "Child PR merged / closed" transcript card
 * surfaced into the PARENT session when a watched child's PR reaches a terminal
 * state. Static (no mutable lifecycle): persisted on the message row and
 * rendered directly, no client store. Carries everything needed to identify the
 * child and its PR so the card is self-explanatory after a reload.
 */
export interface ChildMergedCard {
  /** Server-generated stable id — used for live-append idempotency on reconnect. */
  cardId: string;
  /** The watched child session's id (the card's "Open" target). */
  childSessionId: string;
  /** Child session title, for display. */
  childTitle: string;
  /** Child's branch. */
  branch?: string;
  /** `"merged"` or `"closed-unmerged"` — drives the card's copy + tone. */
  outcome: "merged" | "closed-unmerged";
  prNumber: number;
  prUrl: string;
  prTitle?: string;
  /** Merge commit SHA, when known (merged outcome only). */
  mergeSha?: string;
  createdAt: string;
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

/**
 * An issue label, by display name plus the tracker's own color (SHI-92
 * foundation). Both trackers expose a real per-label color — Linear's
 * `issueLabels[].color`, GitHub's repo `labels[].color` — so the Issues-tab
 * chips can render the tracker's hue instead of a name-hashed guess. `color` is
 * normalized to a CSS-ready hex with a leading `#` (GitHub returns it without
 * one); it's optional because some trackers/paths may not supply it, in which
 * case the client falls back to a deterministic hash of the name.
 */
export interface IssueLabel {
  name: string;
  /** CSS-ready hex (`#rrggbb`) from the tracker, when it supplies one. */
  color?: string;
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
  /**
   * Tracker-internal id of this issue's parent, when it's a sub-issue (docs/206).
   * Drives the nested rendering in the Issues panel — children group under the
   * parent that carries the matching `id`. Linear exposes a `parent` relation;
   * GitHub surfaces none (its tab stays flat), so this is Linear-only in practice.
   * Absent for a top-level issue.
   */
  parentId?: string;
  /**
   * Human identifier of the parent (e.g. "SHI-90"), carried alongside `parentId`
   * so the UI can label an *orphaned* sub-issue — one whose parent fell outside
   * the fetched/filtered window — without a second lookup (docs/206).
   */
  parentIdentifier?: string;
  /**
   * ISO-8601 last-updated timestamp, when the tracker supplies one. Surfaced so
   * the Issues panel can offer a "Last updated" sort key (docs/206); the Linear
   * adapter already orders its fetch by `updatedAt`, this just exposes the value.
   */
  updatedAt?: string;
  priority: IssuePriority;
  /**
   * The issue's labels, each carrying its display name and the tracker's own
   * color (SHI-92 + foundation). Both trackers support labels natively —
   * Linear's issue labels, GitHub's REST labels — and both expose a real color,
   * so the chips render the tracker's hue (falling back to a name hash when
   * `color` is absent). Surfaced so the agent's `--json` output and the
   * provenance card reflect what was set, and so a label edit can snapshot the
   * prior set for undo. Absent when the issue has no labels.
   */
  labels?: IssueLabel[];
  /**
   * Workflow state, e.g. { name: "In Progress", type: "started" }. `color` is the
   * tracker's own per-state color (Linear's state hex) so the UI dot matches the
   * tracker exactly instead of a coarse type→gray guess — the default Linear
   * states (Backlog/Todo/Duplicate) otherwise all collapse to one gray.
   */
  status?: { name: string; type?: string; color?: string };
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
  availableStatuses?: { name: string; type?: string; color?: string }[];
}

/**
 * A comment on an issue. Returned by a write (`addComment`, docs/177 — only `id`
 * is consulted there, for undo) AND by the read path that powers the inline
 * comment thread (`listComments`, docs/189 follow-up). The author + timestamp
 * are optional because a freshly-created comment from a write doesn't always
 * carry them, but `listComments` and the enriched `addComment` populate them so
 * the thread can render avatar/author/relative-date rows.
 */
export interface TrackerComment {
  /** Tracker-internal comment id. Used to undo (delete) the comment. */
  id: string;
  /** Deep link to the comment, when the tracker returns one. */
  url?: string;
  /** The comment body that was posted. */
  body: string;
  /** Comment author, for the thread row. Absent when the tracker omits it. */
  author?: { name: string; avatarUrl?: string };
  /** ISO-8601 creation time, for the relative-date label. */
  createdAt?: string;
}

/** Which kind of issue write a provenance card records (docs/177, docs/187). */
export type IssueWriteVerb = "comment" | "edit" | "status" | "assignee" | "create";

/**
 * docs/189 — the human-readable "what changed" values the redesigned write card
 * renders on its second line. Display-only and verb-specific: the client reads
 * the field that matches `IssueWriteCard.verb`. Distinct from `undo` (the
 * reverse-write snapshot, captured for replay, not display). Every field is
 * optional — the card degrades to its first line when absent (pre-docs/189
 * cards, or a `create`, which has no "before").
 */
export interface IssueWriteContent {
  /** comment → a clipped preview of the posted comment body. */
  comment?: string;
  /** edit → the title transition, present only when the title was edited. */
  title?: { before: string; after: string };
  /** edit → true when the description was among the edited fields. */
  descriptionChanged?: boolean;
  /**
   * edit → a faint one-liner for label/priority changes (e.g.
   * "priority → High · labels: security, bug"), so a labels/priority-only edit
   * still shows what changed rather than rendering an empty second line.
   */
  attrs?: string;
  /** status → the native status names of the transition. */
  status?: { from: string; to: string };
  /** assignee → the new assignee's display name, or null when unassigned. */
  assignee?: string | null;
}

/**
 * The minimal snapshot a do-then-surface write captures so it can be undone as
 * a reverse brokered write (docs/177). Captured BEFORE mutating. The assignee
 * variant stores the prior **tracker-internal id** (GitHub login / Linear
 * `assigneeId`) so undo replays an exact id — never re-running the name→id
 * resolution that could be ambiguous.
 */
export type IssueWriteUndo =
  | { kind: "comment"; commentId: string }
  // SHI-92 — an edit may also change labels/priority; the prior label set and
  // prior priority level are snapshotted so undo restores them (the prior labels
  // replace the post-edit set; the prior priority level is re-applied).
  // `previousLabels` holds label *names* (the write API resolves names → ids),
  // not the colored `IssueLabel` read shape — undo only needs to restore names.
  | {
      kind: "edit";
      previousTitle?: string;
      previousDescription?: string;
      previousLabels?: string[];
      previousPriority?: string;
    }
  | { kind: "status"; previousStatus: string }
  | { kind: "assignee"; previousAssigneeId: string | null }
  // docs/187 — a just-created issue has no prior state to restore; undo cancels
  // it (Linear → canceled state, GitHub → close as not_planned) by `card.issueId`.
  | { kind: "create" };

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
   * docs/189 — display-only "what changed" values for the card's second line
   * (comment preview, title/status/assignee deltas). Optional: absent on
   * pre-docs/189 cards and on a `create`; for a labels/priority-only edit only
   * `content.attrs` is set. NOT consulted by undo — that is `undo`.
   */
  content?: IssueWriteContent;
  /**
   * Whose identity the write is attributed to. GitHub writes use the acting
   * user's own token (`"user"`); Linear writes use the deployment-wide PAT, so
   * they are attributed to the workspace PAT owner (`"workspace"`), NOT the
   * acting user — the card must not claim per-user authorship for Linear.
   *
   * docs/189 — retained in the data model (cheap, useful for a future audit
   * log) but no longer rendered: the card is self-evidently the agent's, so
   * spelling out the backing identity carries no actionable information.
   */
  attribution: "user" | "workspace";
  undo: IssueWriteUndo;
  undoState: IssueWriteUndoState;
  createdAt: string;
  /** Set when an undo attempt failed — shown on the card. */
  errorMessage?: string;
}

/**
 * docs/188 — a lightweight navigation card recording that the agent **read** an
 * issue (`shipit issue view <pointer>`). The write path already surfaces an
 * `IssueWriteCard`; this is its read-only sibling so any agent issue interaction
 * — not just edits — leaves a quick jump-to-issue affordance in the transcript.
 *
 * Unlike the write card it has no lifecycle (no undo), so the full payload lives
 * directly on the persisted chat message and renders without a client store.
 * Shared verbatim by the live WS payload, the persisted row, and the client card
 * so the three can't drift.
 */
export interface IssueRefCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  tracker: TrackerId;
  /** Display identifier, e.g. "SHI-28" or "owner/repo#42". */
  identifier: string;
  /** Issue title at view time, for the card line. */
  title: string;
  /** Deep link to the issue in the tracker (escape hatch). */
  url?: string;
  /** Human status name at view time, e.g. "In Progress" / "Closed". */
  status?: string;
  /** Normalized status type (e.g. "completed"/"canceled") for done-styling. */
  statusType?: string;
  createdAt: string;
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
 * docs/144 — the persisted "Consulted Codex · 47s · $0.03" transcript card for a
 * completed sub-agent spawn. Unlike the transient in-flight spinner (the
 * `sub_agent_spawn` WS message + `subAgentSpawns` store), this terminal record
 * IS transcript content — the user expects it to stay where the consultation
 * happened, surviving a session switch and a full reload — so it follows the
 * side-channel-card persistence contract (emitted via `emitChatCard`, anchored
 * inline at the spawn position, persisted in chat history). Renders for every
 * terminal status, not just success (a cancelled/timed-out/failed consult is
 * still a fact the transcript should keep).
 */
export interface SubAgentConsultCard {
  /** Stable id — keeps the live append + history rehydration idempotent. */
  cardId: string;
  /** The in-flight spawn this card finalizes; clears the matching running chip. */
  spawnId: string;
  /** The agent that was consulted (display: "Consulted Codex"). */
  subAgentId: AgentId;
  /** Terminal status — drives the verb ("Consulted" / "Cancelled" / …). */
  status: "success" | "error" | "timeout" | "cancelled";
  durationMs?: number;
  costUsd?: number;
  /** True when the sub-agent's output hit the wall-clock or character cap. */
  truncated?: boolean;
  createdAt: string;
}

/**
 * docs/207 / SHI-153 — one optional action the agent proposes via the
 * `propose_actions` tool. The card renders these as a button (one action) or a
 * checklist (2+); ticking declares intent and the agent does the work, so no
 * field here ever executes anything directly.
 */
export interface ActionChecklistItem {
  /** Stable id for this action within the card (used as the React key + selection key). */
  id: string;
  /** Short button / checkbox text. */
  label: string;
  /** Optional one-line explanation under the label. */
  description?: string;
  /** The agent's recommendation — pre-ticks the box. The user still decides. */
  defaultChecked?: boolean;
  /**
   * The self-contained instruction the agent receives if this action is chosen.
   * Self-contained on purpose: the card outlives the turn, the agent, even a
   * destroyed-and-re-cloned container, so the submitted message is rebuilt from
   * the ticked `payload`s — never from warm conversation context.
   */
  payload: string;
}

/**
 * docs/207 / SHI-153 — a persisted "action checklist" transcript card. The agent
 * proposes one or more INDEPENDENT optional follow-ups; the user resolves the
 * subset they want with a SINGLE batched submit (one message → one turn, never N
 * racing clicks). The card is an immutable, reusable message composer: it has no
 * terminal state, never locks, and can be re-submitted with a different subset
 * indefinitely. Shared verbatim by the live WS payload (`WsActionChecklistCard`),
 * the persisted chat-history row (`PersistedMessage.actionChecklist`), and the
 * client card so the three can't drift — same pattern as the issue-ref / sub-
 * agent-consult cards (static payload, no client store, no in-place patch path).
 *
 * Provenance (`branch`, `headSha`, `createdAt`) is captured at emit time and is
 * immutable. It travels into the message the card sends so the agent can inspect
 * current state and adapt/decline if an action is now obsolete (branch merged, PR
 * already exists, files moved) — the "honest at click-time" guarantee without a
 * stale *state* or a lock.
 */
export interface ActionChecklistCard {
  /** Stable id — dedupes the live append vs the reconnect/reload replay. */
  cardId: string;
  /** Optional heading, e.g. "Optional follow-ups". */
  title?: string;
  /** 1..N proposed actions. One → button card; two or more → checklist card. */
  actions: ActionChecklistItem[];
  /** Branch the actions were proposed against (provenance, immutable). */
  branch?: string;
  /** Short HEAD SHA the actions were proposed against (provenance, immutable). */
  headSha?: string;
  /** Emit time — doubles as the "proposed <date>" provenance stamp. */
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
  /**
   * The tracker's full set of assignable statuses for the bound scope (docs/191)
   * — Linear's team workflow states, GitHub's fixed Open/Closed. Lets the list's
   * inline status editor offer valid targets without a per-row `getIssue` (list
   * rows don't carry `availableStatuses`; only `getIssue` populates that).
   * Best-effort: absent when the tracker is unconfigured or the lookup failed.
   */
  availableStatuses?: { name: string; type?: string; color?: string }[];
}

/**
 * Response shape for `GET /api/issue/labels?tracker=[&sessionId=]` — the
 * tracker's full set of available labels (name + color), the foundation for a
 * label filter facet and an on-page label editor. The same fetch that yields the
 * real per-label colors the chips render: Linear's team `issueLabels`, GitHub's
 * repo labels. Best-effort/read-only, mirroring `availableStatuses`.
 */
export interface ListLabelsResult {
  labels: IssueLabel[];
}

/**
 * Response shape for `GET /api/issue?tracker=&id=` (docs/189 — the inline
 * single-issue detail view). The read-only sibling of {@link ListIssuesResult}:
 * one fully-hydrated issue (description, labels, `availableStatuses`) plus the
 * tracker info that frames it. Unlike the agent's `issue/view` route this is the
 * UI's own fetch — it emits no transcript card.
 */
export interface GetIssueResult {
  tracker: TrackerInfo;
  issue: TrackerIssue;
}

/**
 * Response shape for `GET /api/issue/comments?tracker=&id=` — the comment thread
 * rendered inline in the issue detail view (docs/189 follow-up). Oldest-first,
 * the order a reader expects in a discussion.
 */
export interface ListIssueCommentsResult {
  comments: TrackerComment[];
}

/**
 * Response shape for `POST /api/issue/comments` — a user posting a comment from
 * the inline detail view. Returns the created comment (enriched with author +
 * timestamp) so the client appends it to the thread without a full refetch.
 * Distinct from the agent's do-then-surface comment write, which returns an
 * `IssueWriteOutcome` and leaves a provenance card in the transcript.
 */
export interface PostIssueCommentResult {
  comment: TrackerComment;
}

/**
 * Response shape for the user-initiated inline status/priority writes (docs/191):
 * `POST /api/issue/status` and `POST /api/issue/priority`. Returns the updated
 * issue so the client patches the open detail view + list row in place. Like the
 * user-posted comment, these are the user's own direct action — no transcript
 * card and no undo lifecycle (distinct from the agent's do-then-surface writes).
 */
export interface MutateIssueResult {
  issue: TrackerIssue;
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
  /** Skills the plugin will install into `<agent skills dir>/skills/<plugin>__<skill>/`. */
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

/** Returned from `installPlugin()` so the client can refresh + report status. */
export interface InstallResult {
  /** The directories written under the active agent's project skills dir (one per skill). */
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

/**
 * docs/203 — the persisted payload of a plain-text AI review card. One card per
 * review run, keyed by `reviewId`; the parent's re-review patches the same
 * record in place (it never stacks a second card). The reviewer returns
 * `markdown` only — no line/selection anchoring, no immutable snapshot — and the
 * card renders it verbatim. `legacy` rows are degraded mappings of the
 * pre-docs/203 `agent_review` column (file + finding count, no markdown).
 */
export interface AiReviewCard {
  reviewId: string;
  filePath: string;
  /** The reviewer's full review as markdown (rendered verbatim in the card). */
  markdown: string;
  /** Short attribution, e.g. "Reviewed by Codex" / "Reviewed by Claude". */
  reviewerLabel: string;
  /** True once the parent's re-review patched this card. */
  reReviewed?: boolean;
  /** True for a degraded legacy `agent_review` row (no markdown available). */
  legacy?: boolean;
  /** Finding count — only meaningful for a degraded legacy row. */
  findingCount?: number;
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
