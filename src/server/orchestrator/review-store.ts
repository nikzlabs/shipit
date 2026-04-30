import crypto from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type {
  FileReview,
  FileReviewType,
  ReviewComment,
  ReviewCommentSource,
} from "../shared/types.js";

interface ReviewRow {
  id: string;
  session_id: string;
  file_path: string;
  file_type: string;
  status: string;
  doc_snapshot_hash: string;
  section_headings: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

interface CommentRow {
  id: string;
  review_id: string;
  kind: string;
  line: number | null;
  section_heading: string | null;
  section_index: number | null;
  text: string;
  source: string;
  created_at: string;
}

/**
 * FileReviewStore — server-side persistence for the unified review surface.
 *
 * Reviews are scoped to a `(sessionId, filePath)` pair. Each session can
 * carry at most one draft per file and an unbounded history of sent reviews.
 * Both line-anchored (code) and section-anchored (markdown) comments live
 * in the same `file_review_comments` table, discriminated by the `kind`
 * column.
 */
export class FileReviewStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private toReview(row: ReviewRow, comments: CommentRow[]): FileReview {
    const parsedComments: ReviewComment[] = comments.map((c) => {
      if (c.kind === "line") {
        return {
          id: c.id,
          kind: "line",
          line: c.line ?? 0,
          text: c.text,
          source: c.source as ReviewCommentSource,
        };
      }
      return {
        id: c.id,
        kind: "section",
        sectionHeading: c.section_heading ?? "",
        sectionIndex: c.section_index ?? 0,
        text: c.text,
        source: c.source as ReviewCommentSource,
      };
    });

    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      fileType: row.file_type as FileReviewType,
      status: row.status as FileReview["status"],
      comments: parsedComments,
      docSnapshotHash: row.doc_snapshot_hash,
      sectionHeadings: JSON.parse(row.section_headings) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at ?? undefined,
    };
  }

  private getCommentsForReview(reviewId: string): CommentRow[] {
    return this.db.prepare(
      "SELECT * FROM file_review_comments WHERE review_id = ? ORDER BY created_at, rowid",
    ).all(reviewId) as CommentRow[];
  }

  /** List all reviews for a (session, file) pair, newest first. */
  listReviews(sessionId: string, filePath: string): FileReview[] {
    const rows = this.db.prepare(
      "SELECT * FROM file_reviews WHERE session_id = ? AND file_path = ? ORDER BY created_at DESC",
    ).all(sessionId, filePath) as ReviewRow[];
    return rows.map((row) => this.toReview(row, this.getCommentsForReview(row.id)));
  }

  /** Get a specific review by ID. */
  getReview(reviewId: string): FileReview | null {
    const row = this.db.prepare(
      "SELECT * FROM file_reviews WHERE id = ?",
    ).get(reviewId) as ReviewRow | undefined;
    if (!row) return null;
    return this.toReview(row, this.getCommentsForReview(row.id));
  }

  /** Get the current draft review for a (session, file) pair, or null. */
  getDraft(sessionId: string, filePath: string): FileReview | null {
    const row = this.db.prepare(
      "SELECT * FROM file_reviews WHERE session_id = ? AND file_path = ? AND status = 'draft'",
    ).get(sessionId, filePath) as ReviewRow | undefined;
    if (!row) return null;
    return this.toReview(row, this.getCommentsForReview(row.id));
  }

  /**
   * Create a new draft review. Returns the existing draft if one already
   * exists for the (session, file) pair (drafts are unique per pair).
   */
  createDraft(
    sessionId: string,
    filePath: string,
    fileType: FileReviewType,
    docSnapshotHash: string,
    sectionHeadings: string[],
  ): FileReview {
    const existing = this.getDraft(sessionId, filePath);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO file_reviews
        (id, session_id, file_path, file_type, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      filePath,
      fileType,
      docSnapshotHash,
      JSON.stringify(sectionHeadings),
      now,
      now,
    );

    return {
      id,
      sessionId,
      filePath,
      fileType,
      status: "draft",
      comments: [],
      docSnapshotHash,
      sectionHeadings,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Add a line-anchored comment to a draft review. */
  addLineComment(
    reviewId: string,
    line: number,
    text: string,
    source: ReviewCommentSource = "human",
  ): ReviewComment {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO file_review_comments
        (id, review_id, kind, line, text, source, created_at)
      VALUES (?, ?, 'line', ?, ?, ?, ?)
    `).run(id, reviewId, line, text, source, new Date().toISOString());
    this.touchReview(reviewId);
    return { id, kind: "line", line, text, source };
  }

  /** Add a section-anchored comment to a draft review. */
  addSectionComment(
    reviewId: string,
    sectionHeading: string,
    sectionIndex: number,
    text: string,
    source: ReviewCommentSource = "human",
  ): ReviewComment {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO file_review_comments
        (id, review_id, kind, section_heading, section_index, text, source, created_at)
      VALUES (?, ?, 'section', ?, ?, ?, ?, ?)
    `).run(
      id,
      reviewId,
      sectionHeading,
      sectionIndex,
      text,
      source,
      new Date().toISOString(),
    );
    this.touchReview(reviewId);
    return { id, kind: "section", sectionHeading, sectionIndex, text, source };
  }

  /** Update a comment's text. */
  updateComment(reviewId: string, commentId: string, text: string): void {
    this.db.prepare(
      "UPDATE file_review_comments SET text = ? WHERE id = ? AND review_id = ?",
    ).run(text, commentId, reviewId);
    this.touchReview(reviewId);
  }

  /** Delete a comment from a review. */
  deleteComment(reviewId: string, commentId: string): void {
    this.db.prepare(
      "DELETE FROM file_review_comments WHERE id = ? AND review_id = ?",
    ).run(commentId, reviewId);
    this.touchReview(reviewId);
  }

  /** Mark a review as sent. */
  markSent(reviewId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE file_reviews SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, reviewId);
  }

  /** Delete a draft review and its comments. */
  deleteDraft(reviewId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM file_review_comments WHERE review_id = ?").run(reviewId);
      this.db.prepare("DELETE FROM file_reviews WHERE id = ? AND status = 'draft'").run(reviewId);
    })();
  }

  private touchReview(reviewId: string): void {
    this.db.prepare(
      "UPDATE file_reviews SET updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), reviewId);
  }
}

// Backwards-compatible alias for callers that still import ReviewStore.
export { FileReviewStore as ReviewStore };
