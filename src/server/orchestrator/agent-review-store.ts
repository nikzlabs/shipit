/**
 * AgentReviewStore — server-side persistence for agent-authored review cards
 * (docs/151).
 *
 * Sits alongside `FileReviewStore` but with very different semantics:
 *   - Every row is by definition agent-authored — there is no `source` column
 *     and no human path into these tables.
 *   - Rows are immutable. There is no draft phase, no Send action, no status
 *     transitions. The row is created complete on first write.
 *   - The file content the reviewer saw is stored on the row
 *     (`snapshot_content`). Anchors index into that string, not into the
 *     live file, so a comment whose quote was present at review time stays
 *     locatable even after the live file moves.
 */

import crypto from "node:crypto";
import type { DatabaseManager } from "../shared/database.js";
import type {
  AgentReview,
  AgentReviewComment,
  FileReviewType,
} from "../shared/types.js";

interface AgentReviewRow {
  id: string;
  session_id: string;
  file_path: string;
  file_type: string;
  snapshot_content: string;
  snapshot_hash: string;
  summary: string | null;
  created_at: string;
}

interface AgentReviewCommentRow {
  id: string;
  agent_review_id: string;
  kind: string;
  line: number | null;
  quoted_text: string | null;
  context_before: string | null;
  context_after: string | null;
  text: string;
  created_at: string;
}

export interface AgentReviewCommentInput {
  kind: "line" | "selection";
  line?: number;
  quotedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  text: string;
}

export class AgentReviewStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private toReview(row: AgentReviewRow, commentRows: AgentReviewCommentRow[]): AgentReview {
    const comments: AgentReviewComment[] = commentRows.map((c) => {
      if (c.kind === "line") {
        return {
          id: c.id,
          kind: "line",
          line: c.line ?? 0,
          text: c.text,
        };
      }
      return {
        id: c.id,
        kind: "selection",
        quotedText: c.quoted_text ?? "",
        contextBefore: c.context_before ?? "",
        contextAfter: c.context_after ?? "",
        text: c.text,
      };
    });

    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      fileType: row.file_type as FileReviewType,
      snapshotContent: row.snapshot_content,
      snapshotHash: row.snapshot_hash,
      ...(row.summary ? { summary: row.summary } : {}),
      comments,
      createdAt: row.created_at,
    };
  }

  private getCommentsForReview(reviewId: string): AgentReviewCommentRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_review_comments WHERE agent_review_id = ? ORDER BY created_at, rowid",
    ).all(reviewId) as AgentReviewCommentRow[];
  }

  /**
   * Create a new agent review with its snapshot and full comment set atomically.
   * Returns the persisted row including generated ids.
   */
  createReview(opts: {
    sessionId: string;
    filePath: string;
    fileType: FileReviewType;
    snapshotContent: string;
    snapshotHash: string;
    summary?: string;
    comments: AgentReviewCommentInput[];
  }): AgentReview {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_reviews
          (id, session_id, file_path, file_type, snapshot_content, snapshot_hash, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        opts.sessionId,
        opts.filePath,
        opts.fileType,
        opts.snapshotContent,
        opts.snapshotHash,
        opts.summary ?? null,
        now,
      );

      for (const c of opts.comments) {
        const commentId = crypto.randomUUID();
        if (c.kind === "line") {
          this.db.prepare(`
            INSERT INTO agent_review_comments
              (id, agent_review_id, kind, line, text, created_at)
            VALUES (?, ?, 'line', ?, ?, ?)
          `).run(commentId, id, c.line ?? 0, c.text, now);
        } else {
          this.db.prepare(`
            INSERT INTO agent_review_comments
              (id, agent_review_id, kind, quoted_text, context_before, context_after, text, created_at)
            VALUES (?, ?, 'selection', ?, ?, ?, ?, ?)
          `).run(
            commentId,
            id,
            c.quotedText ?? "",
            c.contextBefore ?? "",
            c.contextAfter ?? "",
            c.text,
            now,
          );
        }
      }
    });
    insert();

    return this.getReview(id)!;
  }

  /** Fetch a single agent review by id, or null if it doesn't exist. */
  getReview(reviewId: string): AgentReview | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_reviews WHERE id = ?",
    ).get(reviewId) as AgentReviewRow | undefined;
    if (!row) return null;
    return this.toReview(row, this.getCommentsForReview(row.id));
  }
}
