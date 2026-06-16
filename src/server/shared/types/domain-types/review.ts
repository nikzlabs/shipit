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
