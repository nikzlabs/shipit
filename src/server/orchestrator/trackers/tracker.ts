import type {
  TrackerId,
  TrackerInfo,
  TrackerIssue,
  TrackerComment,
  IssueLabel,
} from "../../shared/types.js";

export interface ListIssuesOptions {
  // Canceled issues remain excluded.
  includeDone?: boolean;
  /** Defaults to LIST_ISSUES_CEILING. */
  maxItems?: number;
}

// A list reads at most this many tracker items (GitHub counts pull requests too).
export const LIST_ISSUES_CEILING = 2000;

// A search prints few rows, so it reads further back; the agent's HTTP call times out at 300 s.
export const SEARCH_READ_CEILING = 10_000;

// Comment, label and user reads fail past this rather than act on part of the set.
export const PAGED_READ_CEILING = 10_000;

export function requireWholeRead<T>(read: { items: T[]; complete: boolean }, what: string): T[] {
  if (!read.complete) {
    throw new Error(
      `${what} has more than ${PAGED_READ_CEILING} entries, so ShipIt stopped rather than use part of it.`,
    );
  }
  return read.items;
}

export interface IssueListing {
  issues: TrackerIssue[];
  // False when LIST_ISSUES_CEILING stopped the read before the tracker ran out.
  complete: boolean;
}

export interface SetAssigneeOptions {
  // Undo restores the saved internal id without resolving its name again.
  raw?: boolean;
}

export class TrackerResolutionError extends Error {
  constructor(
    message: string,
    readonly kind: "status" | "assignee" | "label" | "priority" | "parent",
    readonly options: string[],
  ) {
    super(message);
    this.name = "TrackerResolutionError";
  }
}

export class TrackerPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerPermissionError";
  }
}

export interface Tracker {
  readonly id: TrackerId;
  readonly label: string;

  isConfigured(): boolean;

  info(): TrackerInfo;

  listIssues(options?: ListIssuesOptions): Promise<IssueListing>;

  getIssue(id: string): Promise<TrackerIssue | null>;

  listStatuses(): Promise<{ name: string; type?: string; color?: string }[]>;

  listLabels(): Promise<IssueLabel[]>;

  listComments(id: string): Promise<TrackerComment[]>;

  createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
    parent?: string;
  }): Promise<TrackerIssue>;

  // Callers check for name collisions; adapters do not deduplicate.
  createLabel(input: { name: string; color?: string; description?: string }): Promise<IssueLabel & { id: string }>;

  findLabel(name: string): Promise<(IssueLabel & { id: string; description?: string }) | null>;

  // Rename in place so existing issue assignments survive; callers check collisions.
  updateLabel(
    id: string,
    patch: { name?: string; color?: string; description?: string },
  ): Promise<IssueLabel & { id: string; description?: string }>;

  deleteUnusedLabel(id: string, name: string): Promise<void>;

  addComment(id: string, body: string): Promise<TrackerComment>;

  deleteComment(commentId: string): Promise<void>;

  // Enforce issue scope and author identity; return the guarded read's body for undo.
  updateComment(
    issueId: string,
    commentId: string,
    body: string,
  ): Promise<{ comment: TrackerComment; previousBody: string }>;

  // Labels replace the full set. A null parent detaches the issue.
  updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  ): Promise<TrackerIssue>;

  setStatus(id: string, status: string): Promise<TrackerIssue>;

  setAssignee(id: string, assignee: string | null, opts?: SetAssigneeOptions): Promise<TrackerIssue>;
}
