export type ReviewStatus = "draft" | "sent";

export type FileReviewType = "code" | "markdown";

export interface LineReviewComment {
  id: string;
  kind: "line";
  line: number;
  text: string;
}

/** Context disambiguates repeated quotes; missing quotes render orphaned, not re-anchored. */
export interface SelectionReviewComment {
  id: string;
  kind: "selection";
  quotedText: string;
  contextBefore: string;
  contextAfter: string;
  text: string;
}

export type ReviewComment = LineReviewComment | SelectionReviewComment;

/** Re-review updates the same reviewId. Legacy rows have no markdown. */
export interface AiReviewCard {
  reviewId: string;
  filePath: string;
  markdown: string;
  reviewerLabel: string;
  reReviewed?: boolean;
  legacy?: boolean;
  findingCount?: number;
  createdAt: string;
}

export interface FileReview {
  id: string;
  sessionId: string;
  filePath: string;
  fileType: FileReviewType;
  status: ReviewStatus;
  comments: ReviewComment[];
  /** SHA-256 when the draft was created. */
  docSnapshotHash: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  /** Optional user note added when sending; absent on drafts. */
  note?: string;
}

export interface LineComment {
  id: string;
  kind: "line";
  filePath: string;
  line: number;
  text: string;
}
