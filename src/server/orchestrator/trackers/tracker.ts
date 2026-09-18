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

  listIssues(options?: ListIssuesOptions): Promise<TrackerIssue[]>;

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
