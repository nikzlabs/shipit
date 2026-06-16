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
