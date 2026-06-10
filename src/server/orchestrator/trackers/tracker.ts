/**
 * Tracker abstraction (docs/170 — inline tracker Issues tab).
 *
 * Modeled on the `agents/` registry: adding a tracker later is "write an
 * adapter + register it," and the Issues tab's sub-tabs are generated from the
 * configured-tracker registry. v1 registers Linear only; the interface is
 * shaped so a GitHub Issues adapter (deferred per the SHI-67 scope) can slot in
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
     * or a priority value (SHI-92 added label/priority).
     */
    readonly kind: "status" | "assignee" | "label" | "priority",
    /** Concrete, valid choices the agent can retry with. */
    readonly options: string[],
  ) {
    super(message);
    this.name = "TrackerResolutionError";
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
  listStatuses(): Promise<{ name: string; type?: string }[]>;

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
   * rather than silently creating a stray label (SHI-92). `priority` is a
   * normalized level (`urgent|high|medium|low|none`) or a native priority name —
   * Linear maps it to its numeric field; GitHub (no native priority) throws.
   */
  createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
  }): Promise<TrackerIssue>;

  /** Add a comment to an issue. Returns the created comment (id used for undo). */
  addComment(id: string, body: string): Promise<TrackerComment>;

  /** Delete a comment by its tracker-internal id (reverses {@link addComment}). */
  deleteComment(commentId: string): Promise<void>;

  /**
   * Edit an issue's title, description, labels, and/or priority. Returns the
   * updated issue. `labels`, when present, is the EXACT set to apply (a replace,
   * not a merge) — the caller computes the additive set and passes the full list
   * (SHI-92); names resolve per tracker, an unknown one throws
   * {@link TrackerResolutionError}. `priority` follows the same rules as
   * {@link createIssue}.
   */
  updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string },
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
