/**
 * Tracker abstraction (docs/170 — inline tracker Issues tab).
 *
 * Modeled on the `agents/` registry: adding a tracker later is "write an
 * adapter + register it," and the Issues tab's sub-tabs are generated from the
 * configured-tracker registry. v1 registers Linear only; the interface is
 * shaped so a GitHub Issues adapter (deferred per the planning#69 scope) can slot in
 * without touching the route, the registry contract, or the client.
 *
 * Trackers are repo/workspace-scoped, not session-scoped: a Linear workspace is
 * deployment-wide, so the binding lives in `CredentialStore`, not on a session.
 */

import type {
  TrackerId,
  TrackerInfo,
  TrackerIssue,
  TrackerComment,
  IssueLabel,
} from "../../shared/types.js";

/** Options narrowing what {@link Tracker.listIssues} returns. */
export interface ListIssuesOptions {
  /**
   * Include "done"/completed issues in the result. By default the list is the
   * open-issues working set (completed + canceled excluded). Canceled issues
   * stay excluded even when this is set — "done" means finished, not abandoned.
   */
  includeDone?: boolean;
}

/** Options for {@link Tracker.setAssignee}. */
export interface SetAssigneeOptions {
  /**
   * Treat `assignee` as an already-resolved tracker-internal id (GitHub login,
   * Linear `assigneeId`) and assign it verbatim, skipping name→id resolution.
   * Used by the undo path, which replays the snapshotted prior id so it can't
   * be mis-resolved by the same ambiguity that flagged the forward write
   * (docs/177).
   */
  raw?: boolean;
}

/**
 * A status target that couldn't be resolved to a concrete state — thrown by
 * {@link Tracker.setStatus} / {@link Tracker.setAssignee} so the caller can
 * surface the valid options instead of a bare failure (docs/177). The agent
 * retries with one of `options`.
 */
export class TrackerResolutionError extends Error {
  constructor(
    message: string,
    /**
     * Which write tripped: a status target, an assignee handle, a label name,
     * a priority value (planning#94 added label/priority), or a parent pointer
     * (planning#208 added parent — used to reject `--parent` on GitHub).
     */
    readonly kind: "status" | "assignee" | "label" | "priority" | "parent",
    /** Concrete, valid choices the agent can retry with. */
    readonly options: string[],
  ) {
    super(message);
    this.name = "TrackerResolutionError";
  }
}

/**
 * A write the tracker would happily perform but ShipIt refuses — thrown by
 * {@link Tracker.updateComment} when the comment was authored by someone other
 * than the identity ShipIt writes as (planning#88).
 *
 * Deliberately NOT a {@link TrackerResolutionError}: nothing failed to resolve
 * and there is no alternative value to retry with, so it carries no options and
 * the service maps it to **403** rather than 422. An agent that sees it should
 * post a new comment, not hunt for a form of the request that works.
 */
export class TrackerPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerPermissionError";
  }
}

export interface Tracker {
  /** Stable id, e.g. "linear". Drives the `?tracker=` query and the sub-tab. */
  readonly id: TrackerId;
  /** Human label for the sub-tab, e.g. "Linear". */
  readonly label: string;

  /**
   * Whether this tracker is ready to list issues — both auth (a token) and the
   * repo→tracker binding (a Linear team) are present. When false the Issues tab
   * renders a "Connect <tracker>" empty state instead of erroring.
   */
  isConfigured(): boolean;

  /** Metadata for the sub-tab switcher + configured/empty-state rendering. */
  info(): TrackerInfo;

  /**
   * List issues for the bound scope, sorted by priority (urgent first). Throws
   * if the tracker isn't configured — callers should check `isConfigured()`
   * first and surface the empty state. By default returns only the open working
   * set; pass `{ includeDone: true }` to also include completed issues.
   */
  listIssues(options?: ListIssuesOptions): Promise<TrackerIssue[]>;

  /** Fetch a single issue by tracker-internal id, or null if not found. */
  getIssue(id: string): Promise<TrackerIssue | null>;

  /**
   * The full set of assignable statuses for the tracker's bound scope (docs/191)
   * — Linear's team workflow states, GitHub's fixed Open/Closed pair. Powers the
   * inline status editor's option list on the issue LIST, where rows don't carry
   * the per-issue `availableStatuses` that `getIssue` populates. Ordered as the
   * tracker presents them (Linear board position). Throws on an unconfigured
   * tracker (callers check `isConfigured()` first).
   */
  listStatuses(): Promise<{ name: string; type?: string; color?: string }[]>;

  /**
   * The full set of labels for the tracker's bound scope (planning#94 foundation) —
   * Linear's team/workspace `issueLabels`, GitHub's repo labels — each with its
   * tracker-supplied color. Powers the available-labels endpoint a follow-up
   * label filter/editor consumes, and is the same fetch that yields the real
   * colors the chips render. Throws on an unconfigured tracker (callers check
   * `isConfigured()` first).
   */
  listLabels(): Promise<IssueLabel[]>;

  /**
   * List an issue's comments, oldest-first, for the inline comment thread
   * (docs/189 follow-up). Each comment carries its author + creation time so the
   * thread renders avatar/author/relative-date rows. Throws on an unconfigured
   * tracker (callers check `isConfigured()` first).
   */
  listComments(id: string): Promise<TrackerComment[]>;

  // ---- Writes (docs/177) ----------------------------------------------------
  // Mutations go through the same adapter that does reads. Tokens stay
  // orchestrator-side; only the result returns to the caller. Each method
  // throws on an unconfigured tracker (callers check `isConfigured()` first).

  /**
   * Create a new issue in the bound scope (Linear team / GitHub session repo)
   * and return it (docs/187). The created issue's id is the undo target — undo
   * cancels/closes it rather than deleting (GitHub can't delete via REST).
   *
   * `labels` are display names resolved per tracker; an unknown/ambiguous name
   * throws {@link TrackerResolutionError} (`kind: "label"`) listing candidates
   * rather than silently creating a stray label (planning#94). `priority` is a
   * normalized level (`urgent|high|medium|low|none`) or a native priority name —
   * Linear maps it to its numeric field; GitHub (no native priority) throws.
   * `parent` is a tracker-native issue id/key the new issue nests under as a
   * sub-issue (planning#208) — Linear-only; GitHub (flat issues) throws
   * {@link TrackerResolutionError} (`kind: "parent"`).
   */
  createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
    parent?: string;
  }): Promise<TrackerIssue>;

  /**
   * Create a new label in the bound scope (Linear team / GitHub repo) so it can
   * be applied via `--label` (planning#232 — the agent's `shipit issue label create`).
   * `color` is a CSS-ready `#rrggbb` (adapters renormalize per tracker API).
   * Callers pre-check for an existing same-name label (case-insensitive) — the
   * adapter does not dedupe. Returns the created label plus its tracker-internal
   * `id` (Linear UUID; for GitHub the name IS the id), which the undo snapshot
   * carries as the delete target.
   */
  createLabel(input: { name: string; color?: string; description?: string }): Promise<IssueLabel & { id: string }>;

  /**
   * Look one label up by display name (case-insensitive), or null when the
   * tracker has none by that name (planning#88 — `shipit issue label edit`).
   *
   * Distinct from {@link listLabels}, which returns the pickable `{name, color}`
   * set the UI renders: this carries the tracker-internal `id` {@link updateLabel}
   * writes through and the `description`, so one lookup both resolves the target
   * and yields the snapshot undo restores. Linear prefers a label owned by the
   * declared team over a same-named one in another team; the team guard in
   * `updateLabel` is what actually refuses the latter.
   */
  findLabel(name: string): Promise<(IssueLabel & { id: string; description?: string }) | null>;

  /**
   * Rewrite an existing label's name, color and/or description in the bound
   * scope (planning#88), returning it as it now stands. `id` is the tracker-internal
   * id from {@link findLabel} / {@link createLabel} (Linear UUID; for GitHub the
   * label's current name IS its id). Only the fields present in `patch` are
   * touched.
   *
   * A rename is deliberately in scope and is NOT a re-labeling: both backends
   * rename in place (`PATCH /labels/{name}` with `new_name`; `issueLabelUpdate`),
   * so every issue carrying the label keeps carrying it and simply displays the
   * new name — which is what makes the reverse write a true undo. Callers
   * pre-check that a new name doesn't collide with a DIFFERENT label, because
   * neither backend merges cleanly.
   *
   * Linear only: the label must belong to the declared team (`assertOwnTeam`, the
   * guard `deleteUnusedLabel` also applies) — a label id is workspace-global, so
   * the check is enforced here, server-side, where a direct relay POST can't
   * bypass it.
   */
  updateLabel(
    id: string,
    patch: { name?: string; color?: string; description?: string },
  ): Promise<IssueLabel & { id: string; description?: string }>;

  /**
   * Delete a label ONLY when no issues carry it — the reverse write behind a
   * label-creation card's Undo (planning#232). When the label is in use the adapter
   * throws with an explanation (surfaced as the card's undo error) instead of
   * stripping it off issues; `name` is for that message, `id` is the tracker-
   * internal delete target from {@link createLabel}.
   */
  deleteUnusedLabel(id: string, name: string): Promise<void>;

  /** Add a comment to an issue. Returns the created comment (id used for undo). */
  addComment(id: string, body: string): Promise<TrackerComment>;

  /** Delete a comment by its tracker-internal id (reverses {@link addComment}). */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Rewrite a comment's body (planning#88 — `shipit issue comment edit`), returning
   * the updated comment **and the body it replaced** so the caller can snapshot
   * the prior text for undo. The prior body comes back from here rather than
   * from a separate read because the adapter must fetch the comment anyway to
   * run the two guards below — so the snapshot is taken from the same response
   * the checks ran against, and costs no extra round-trip.
   *
   * Three things are enforced, because a comment id is **backend-global** on
   * both trackers and the caller-supplied `issueId` is the only thing scoping it:
   *
   * 1. The comment must belong to `issueId` — otherwise a global id could
   *    redirect the write onto an unrelated issue (or, on GitHub, an unrelated
   *    repository) that the operation never named.
   * 2. The comment must be authored by the identity ShipIt writes as — the
   *    acting user's GitHub token, or the deployment's Linear PAT. Editing
   *    anyone else's comment silently rewrites a human's words, and neither
   *    backend refuses it, so ShipIt does: {@link TrackerPermissionError}.
   * 3. Linear only: the issue must belong to the declared team (`assertOwnTeam`,
   *    the same guard `deleteComment` applies).
   */
  updateComment(
    issueId: string,
    commentId: string,
    body: string,
  ): Promise<{ comment: TrackerComment; previousBody: string }>;

  /**
   * Edit an issue's title, description, labels, and/or priority. Returns the
   * updated issue. `labels`, when present, is the EXACT set to apply (a replace,
   * not a merge) — the caller computes the additive set and passes the full list
   * (planning#94); names resolve per tracker, an unknown one throws
   * {@link TrackerResolutionError}. `priority` follows the same rules as
   * {@link createIssue}. `parent` reparents the issue (planning#208): a tracker-native
   * id/key to nest under, or `null` to detach into a top-level issue — Linear-only
   * (GitHub throws `kind: "parent"`).
   */
  updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  ): Promise<TrackerIssue>;

  /**
   * Set an issue's status from EITHER a normalized type (`started`,
   * `completed`, `canceled`, …) OR a native state name (`"In Review"`). The
   * adapter resolves it per its model; on an unknown/ambiguous value it throws
   * {@link TrackerResolutionError} listing the valid states.
   */
  setStatus(id: string, status: string): Promise<TrackerIssue>;

  /**
   * Set (or, with `null`, clear) an issue's assignee. `assignee` is a login,
   * email, display name, or `"me"`; the adapter resolves it to an internal id,
   * throwing {@link TrackerResolutionError} with candidates on no/ambiguous
   * match. Pass `{ raw: true }` to assign an already-resolved internal id.
   */
  setAssignee(id: string, assignee: string | null, opts?: SetAssigneeOptions): Promise<TrackerIssue>;
}
