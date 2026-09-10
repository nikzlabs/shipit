// Use tracker-id.ts helpers to preserve destinations. Bare linear is legacy and fails closed.
export type TrackerId = "linear" | "github" | `github:${string}` | `linear:${string}`;

export type IssuePriorityLevel = "urgent" | "high" | "medium" | "low" | "none";

export interface IssuePriority {
  level: IssuePriorityLevel;
  /** Ascending: urgent=0, none=4. */
  sortOrder: number;
  label: string;
}

export interface IssueLabel {
  name: string;
  /** CSS-ready hex, including #. */
  color?: string;
}

export interface TrackerIssue {
  /** Tracker-internal ID, distinct from the display identifier. */
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string;
  parentId?: string;
  parentIdentifier?: string;
  updatedAt?: string;
  createdAt?: string;
  priority: IssuePriority;
  labels?: IssueLabel[];
  status?: { name: string; type?: string; color?: string };
  assignee?: { name: string; avatarUrl?: string };
  /** Native ID for exact undo, without ambiguous name resolution. */
  assigneeId?: string;
  /** Populated by getIssue, not listIssues. */
  availableStatuses?: { name: string; type?: string; color?: string }[];
}

export interface TrackerComment {
  id: string;
  url?: string;
  body: string;
  author?: { name: string; avatarUrl?: string };
  createdAt?: string;
}

export type IssueWriteVerb =
  | "comment"
  | "comment-edit"
  | "edit"
  | "status"
  | "assignee"
  | "create"
  | "label"
  | "label-edit";

/** Display-only changes; undo uses its own pre-write snapshot. */
export interface IssueWriteContent {
  comment?: string;
  title?: { before: string; after: string };
  descriptionChanged?: boolean;
  attrs?: string;
  label?: { before: string; after: string };
  status?: { from: string; to: string };
  assignee?: string | null;
}

/** Capture before mutation, using exact native IDs. */
export type IssueWriteUndo =
  | { kind: "comment"; commentId: string }
  | { kind: "comment-edit"; commentId: string; previousBody: string }
  | {
      kind: "edit";
      previousTitle?: string;
      previousDescription?: string;
      previousLabels?: string[];
      previousPriority?: string;
      previousParentId?: string | null;
    }
  | { kind: "status"; previousStatus: string }
  | { kind: "assignee"; previousAssigneeId: string | null }
  // Creation undo cancels the issue rather than deleting it.
  | { kind: "create" }
  // Delete only while unused.
  | { kind: "label"; labelId: string; labelName: string }
  | {
      kind: "label-edit";
      /** Post-edit ID: GitHub label names are IDs, so renaming changes this. */
      labelId: string;
      previousName?: string;
      previousColor?: string;
      previousDescription?: string;
    };

export type IssueWriteUndoState = "available" | "undoing" | "undone" | "failed";

export interface IssueWriteCard {
  cardId: string;
  /** Original undo destination, retained even if its declaration is removed. */
  tracker: TrackerId;
  /** Detect repointing and refuse undo; never redirect the snapshot to a different destination. */
  trackerName?: string;
  issueId: string;
  identifier: string;
  title: string;
  url?: string;
  verb: IssueWriteVerb;
  summary: string;
  content?: IssueWriteContent;
  attribution: "user" | "workspace";
  undo: IssueWriteUndo;
  undoState: IssueWriteUndoState;
  createdAt: string;
  errorMessage?: string;
}

export interface IssueRefCard {
  cardId: string;
  tracker: TrackerId;
  /** Navigation follows the name's current binding; tracker is the unnamed fallback. */
  trackerName?: string;
  identifier: string;
  title: string;
  url?: string;
  status?: string;
  statusType?: string;
  createdAt: string;
}

export interface TrackerInfo {
  id: TrackerId;
  label: string;
  configured: boolean;
  name?: string;
  binding?: { key: string; name: string };
  kind: "github" | "linear";
}

export interface ListIssuesResult {
  tracker: TrackerInfo;
  issues: TrackerIssue[];
  availableStatuses?: { name: string; type?: string; color?: string }[];
}

export interface ListLabelsResult {
  labels: IssueLabel[];
}

export interface GetIssueResult {
  tracker: TrackerInfo;
  issue: TrackerIssue;
}

export interface ListIssueCommentsResult {
  comments: TrackerComment[];
}

export interface PostIssueCommentResult {
  comment: TrackerComment;
}

export interface MutateIssueResult {
  issue: TrackerIssue;
}

export interface IssueRef {
  tracker: TrackerId;
  identifier: string;
  title: string;
  url?: string;
  description?: string;
  providerData?: Record<string, string>;
}
