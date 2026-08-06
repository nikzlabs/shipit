// ---- Issue tracker types (docs/170 — inline tracker Issues tab) ----

/**
 * Identifier for an issue tracker **destination**. Drives the Issues tab's
 * sub-tab switcher and the `?tracker=` query.
 *
 * Not a closed union (docs/248): a destination comes from an `issues.trackers`
 * declaration in a repository's `shipit.yaml`, which is not drawn from a fixed
 * set, so the id has to stay open-ended. The template-literal members keep that
 * open end typed rather than degrading the whole union to `string`.
 *
 *  - `` `github:${owner}/${repo}` `` — a GitHub repository.
 *  - `` `linear:${TEAM}` `` — a Linear team (req 5).
 *  - `"github"` — the active session's own code repository, the single
 *    destination requirement 12 lets an operation reach without naming it.
 *  - `"linear"` — the retired deployment-wide Linear binding. Requirement 1
 *    removed it, so nothing produces it any more; the member survives only so
 *    persisted cards written before the rework still typecheck (they fail closed
 *    on resolution, which is what requirement 20 permits).
 *
 * Build and inspect qualified ids with the helpers in `shared/tracker-id.ts`
 * (`githubTrackerId`, `linearTrackerId`, `parseGitHubTrackerId`,
 * `isGitHubTracker`) — never by comparing against a bare literal, which silently
 * drops the destination.
 */
export type TrackerId = "linear" | "github" | `github:${string}` | `linear:${string}`;

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
  /**
   * ISO-8601 creation timestamp, when the tracker supplies one. Tracker-neutral:
   * Linear's `createdAt` and GitHub's `created_at` both map here. Surfaced so an
   * issue's original creation date is readable through `shipit issue view --json`
   * — a migration that recreates issues on another backend has to record when
   * each one was actually filed (docs/247 req 9), and the recreated issue's own
   * `createdAt` is the migration date, not the original.
   */
  createdAt?: string;
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

/**
 * Which kind of issue write a provenance card records (docs/177, docs/187).
 * `label` records a label CREATION (`shipit issue label create`, or one minted
 * by `--create-missing-labels`) — the one write verb that targets tracker
 * config rather than an issue, so its card carries the label name as the
 * identifier and no issue id.
 */
export type IssueWriteVerb = "comment" | "edit" | "status" | "assignee" | "create" | "label";

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
      // SHI-206 — an edit may also reparent (Linear sub-issues). The prior
      // parent's tracker-internal id is snapshotted (or `null` when it had no
      // parent) so undo restores the exact prior relation — re-parenting back to
      // the prior id, or detaching when there was none.
      previousParentId?: string | null;
    }
  | { kind: "status"; previousStatus: string }
  | { kind: "assignee"; previousAssigneeId: string | null }
  // docs/187 — a just-created issue has no prior state to restore; undo cancels
  // it (Linear → canceled state, GitHub → close as not_planned) by `card.issueId`.
  | { kind: "create" }
  // Label creation — undo deletes the label IF it's still unused; when issues
  // already carry it the delete refuses with an explanation (shown on the card).
  // `labelId` is the tracker-internal delete target (Linear UUID; for GitHub the
  // label name IS the id), `labelName` the display name for messaging.
  | { kind: "label"; labelId: string; labelName: string };

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
  /**
   * The destination the write actually reached. Undo falls back to this when
   * `trackerName` no longer resolves, which is req 11's one carve-out: reversing
   * a write grants no access the write did not already have (the card could only
   * exist if the destination was declared when it was written), so an Undo must
   * survive the destination being un-declared rather than stranding behind a
   * config edit.
   */
  tracker: TrackerId;
  /**
   * docs/248 — the tracker **name** the write was addressed by, when it had one.
   *
   * NOT the undo target: `tracker` is. Undo reverses a change made to a specific
   * issue, so following a re-pointed name would apply this card's snapshot to a
   * different issue of the same number (req 11). `trackerName` is recorded so
   * `undoIssueWrite` can DETECT that the name has moved and refuse, and so the
   * card renders and links in the name form (req 15). A write addressed by a
   * canonical address has no name and simply uses `tracker`.
   */
  trackerName?: string;
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
  /**
   * The declared name this read was addressed through, when it had one (docs/248
   * req 16). Recorded for the same reason `IssueWriteCard.trackerName` is: the
   * card outlives the declaration it was written against, so clicking it must
   * re-resolve through whatever the NAME points at today rather than the
   * destination it happened to resolve to then. `tracker` stays as the fallback
   * for a card written without a name.
   */
  trackerName?: string;
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
  /**
   * docs/248 req 2 — the `name` this tracker was declared under, and how every
   * reference and operation addresses it. Absent for the session's own code
   * repository, the one destination that needs no declaration (req 12).
   *
   * The browser builds its reference-resolution context out of this list rather
   * than fetching the declarations separately, so this field (plus `id` and
   * `binding.key`) is what makes `planning#42` resolvable in a chip.
   */
  name?: string;
  /** The backend's own identity: GitHub `owner/repo`, Linear team key. */
  binding?: { key: string; name: string };
  /** docs/248 — which backend this destination is on. */
  kind: "github" | "linear";
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
