import crypto from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type { DocReview, ReviewComment, ReviewCommentSource } from "../shared/types.js";

interface ReviewRow {
  id: string;
  feature_id: string;
  plan_path: string;
  status: string;
  doc_snapshot_hash: string;
  section_headings: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  sent_to_session_id: string | null;
}

interface CommentRow {
  id: string;
  review_id: string;
  section_heading: string;
  section_index: number;
  text: string;
  source: string;
}

export class ReviewStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private toReview(row: ReviewRow, comments: CommentRow[]): DocReview {
    return {
      id: row.id,
      featureId: row.feature_id,
      planPath: row.plan_path,
      status: row.status as DocReview["status"],
      comments: comments.map((c) => ({
        id: c.id,
        sectionHeading: c.section_heading,
        sectionIndex: c.section_index,
        text: c.text,
        source: c.source as ReviewCommentSource,
      })),
      docSnapshotHash: row.doc_snapshot_hash,
      sectionHeadings: JSON.parse(row.section_headings) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at ?? undefined,
      sentToSessionId: row.sent_to_session_id ?? undefined,
    };
  }

  private getCommentsForReview(reviewId: string): CommentRow[] {
    return this.db.prepare(
      "SELECT * FROM review_comments WHERE review_id = ? ORDER BY section_index, rowid",
    ).all(reviewId) as CommentRow[];
  }

  /** List all reviews for a feature, newest first. */
  listReviews(featureId: string): DocReview[] {
    const rows = this.db.prepare(
      "SELECT * FROM doc_reviews WHERE feature_id = ? ORDER BY created_at DESC",
    ).all(featureId) as ReviewRow[];
    return rows.map((row) => this.toReview(row, this.getCommentsForReview(row.id)));
  }

  /** Get a specific review by ID. */
  getReview(featureId: string, reviewId: string): DocReview | null {
    const row = this.db.prepare(
      "SELECT * FROM doc_reviews WHERE feature_id = ? AND id = ?",
    ).get(featureId, reviewId) as ReviewRow | undefined;
    if (!row) return null;
    return this.toReview(row, this.getCommentsForReview(row.id));
  }

  /** Get the current draft review for a feature, or null. */
  getDraft(featureId: string): DocReview | null {
    const row = this.db.prepare(
      "SELECT * FROM doc_reviews WHERE feature_id = ? AND status = 'draft'",
    ).get(featureId) as ReviewRow | undefined;
    if (!row) return null;
    return this.toReview(row, this.getCommentsForReview(row.id));
  }

  /** Create a new draft review. Returns existing draft if one exists. */
  createDraft(featureId: string, planPath: string, docSnapshotHash: string, sectionHeadings: string[]): DocReview {
    const existing = this.getDraft(featureId);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO doc_reviews (id, feature_id, plan_path, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, featureId, planPath, docSnapshotHash, JSON.stringify(sectionHeadings), now, now);

    return {
      id,
      featureId,
      planPath,
      status: "draft",
      comments: [],
      docSnapshotHash,
      sectionHeadings,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Add a comment to a draft review. */
  addComment(
    featureId: string,
    reviewId: string,
    comment: { sectionHeading: string; sectionIndex: number; text: string; source: ReviewCommentSource },
  ): ReviewComment {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO review_comments (id, review_id, section_heading, section_index, text, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, reviewId, comment.sectionHeading, comment.sectionIndex, comment.text, comment.source);

    this.touchReview(reviewId);

    return {
      id,
      sectionHeading: comment.sectionHeading,
      sectionIndex: comment.sectionIndex,
      text: comment.text,
      source: comment.source,
    };
  }

  /** Update a comment's text. */
  updateComment(featureId: string, reviewId: string, commentId: string, text: string): void {
    this.db.prepare(
      "UPDATE review_comments SET text = ? WHERE id = ? AND review_id = ?",
    ).run(text, commentId, reviewId);
    this.touchReview(reviewId);
  }

  /** Delete a comment from a review. */
  deleteComment(featureId: string, reviewId: string, commentId: string): void {
    this.db.prepare(
      "DELETE FROM review_comments WHERE id = ? AND review_id = ?",
    ).run(commentId, reviewId);
    this.touchReview(reviewId);
  }

  /** Mark a review as sent. */
  markSent(featureId: string, reviewId: string, sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE doc_reviews SET status = 'sent', sent_at = ?, sent_to_session_id = ?, updated_at = ? WHERE id = ? AND feature_id = ?",
    ).run(now, sessionId, now, reviewId, featureId);
  }

  /** Delete a draft review and its comments. */
  deleteDraft(featureId: string, reviewId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM review_comments WHERE review_id = ?").run(reviewId);
      this.db.prepare("DELETE FROM doc_reviews WHERE id = ? AND feature_id = ? AND status = 'draft'").run(reviewId, featureId);
    })();
  }

  private touchReview(reviewId: string): void {
    this.db.prepare(
      "UPDATE doc_reviews SET updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), reviewId);
  }
}
