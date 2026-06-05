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
    /** Which write tripped: a status target or an assignee handle. */
    readonly kind: "status" | "assignee",
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

  // ---- Writes (docs/177) ----------------------------------------------------
  // Mutations go through the same adapter that does reads. Tokens stay
  // orchestrator-side; only the result returns to the caller. Each method
  // throws on an unconfigured tracker (callers check `isConfigured()` first).

  /** Add a comment to an issue. Returns the created comment (id used for undo). */
  addComment(id: string, body: string): Promise<TrackerComment>;

  /** Delete a comment by its tracker-internal id (reverses {@link addComment}). */
  deleteComment(commentId: string): Promise<void>;

  /** Edit an issue's title and/or description. Returns the updated issue. */
  updateIssue(id: string, patch: { title?: string; description?: string }): Promise<TrackerIssue>;

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
