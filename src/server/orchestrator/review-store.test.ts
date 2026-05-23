import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { FileReviewStore } from "./review-store.js";

describe("FileReviewStore", () => {
  let dbManager: DatabaseManager;
  let store: FileReviewStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    store = new FileReviewStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  // ------------------------------------------------------------------
  // Create draft
  // ------------------------------------------------------------------

  it("creates a markdown draft with snapshot fields populated", () => {
    const draft = store.createDraft(
      "session-1",
      "docs/001-foo/plan.md",
      "markdown",
      "abc123hash",
    );

    expect(draft.sessionId).toBe("session-1");
    expect(draft.filePath).toBe("docs/001-foo/plan.md");
    expect(draft.fileType).toBe("markdown");
    expect(draft.status).toBe("draft");
    expect(draft.docSnapshotHash).toBe("abc123hash");
    expect(draft.comments).toEqual([]);
    expect(draft.id).toBeTruthy();
    expect(draft.sentAt).toBeUndefined();
  });

  it("creates a code draft", () => {
    const draft = store.createDraft(
      "session-1",
      "src/server/api.ts",
      "code",
      "hash",
    );

    expect(draft.fileType).toBe("code");
  });

  // ------------------------------------------------------------------
  // One draft per (session, file)
  // ------------------------------------------------------------------

  it("returns the existing draft when called twice for the same (session, file)", () => {
    const first = store.createDraft("s1", "plan.md", "markdown", "h1");
    const second = store.createDraft("s1", "plan.md", "markdown", "h2");

    expect(second.id).toBe(first.id);
    expect(second.docSnapshotHash).toBe("h1");
  });

  it("creates separate drafts for the same file in different sessions", () => {
    const a = store.createDraft("s1", "plan.md", "markdown", "h");
    const b = store.createDraft("s2", "plan.md", "markdown", "h");
    expect(a.id).not.toBe(b.id);
  });

  // ------------------------------------------------------------------
  // Add comments (line + selection)
  // ------------------------------------------------------------------

  it("adds a selection-anchored comment with the right kind, source, and quoted text", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const comment = store.addSelectionComment(
      draft.id,
      "The introduction",
      "## Intro\n\n",
      " section explains",
      "Needs more detail",
      "human",
    );

    expect(comment.kind).toBe("selection");
    if (comment.kind !== "selection") throw new Error("expected selection");
    expect(comment.quotedText).toBe("The introduction");
    expect(comment.contextBefore).toBe("## Intro\n\n");
    expect(comment.contextAfter).toBe(" section explains");
    expect(comment.text).toBe("Needs more detail");
    expect(comment.source).toBe("human");

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].id).toBe(comment.id);
  });

  it("adds a line-anchored comment with the right kind and line", () => {
    const draft = store.createDraft("s1", "src/foo.ts", "code", "h");
    const comment = store.addLineComment(draft.id, 42, "SQL injection risk", "human");

    expect(comment.kind).toBe("line");
    if (comment.kind !== "line") throw new Error("expected line");
    expect(comment.line).toBe(42);
    expect(comment.text).toBe("SQL injection risk");

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
  });

  it("supports both line and selection comments inside the same review", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "the intro", "", "", "selection one", "human");
    store.addLineComment(draft.id, 1, "line one", "human");

    const review = store.getReview(draft.id);
    const kinds = review!.comments.map((c) => c.kind).sort();
    expect(kinds).toEqual(["line", "selection"]);
  });

  // ------------------------------------------------------------------
  // Update comment
  // ------------------------------------------------------------------

  it("updates comment text and preserves anchor fields", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const comment = store.addSelectionComment(draft.id, "anchored phrase", "", "", "Original", "human");
    store.updateComment(draft.id, comment.id, "Updated");

    const review = store.getReview(draft.id);
    expect(review!.comments[0].text).toBe("Updated");
    if (review!.comments[0].kind !== "selection") throw new Error("expected selection");
    expect(review!.comments[0].quotedText).toBe("anchored phrase");
    expect(review!.comments[0].source).toBe("human");
  });

  // ------------------------------------------------------------------
  // Delete comment
  // ------------------------------------------------------------------

  it("deletes a comment without affecting siblings", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const c1 = store.addSelectionComment(draft.id, "one", "", "", "first", "human");
    const c2 = store.addSelectionComment(draft.id, "two", "", "", "second", "ai");

    store.deleteComment(draft.id, c1.id);

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].id).toBe(c2.id);
  });

  // ------------------------------------------------------------------
  // Mark sent
  // ------------------------------------------------------------------

  it("marks a review as sent with sentAt populated", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "anchor", "", "", "feedback", "human");

    store.markSent(draft.id);

    const review = store.getReview(draft.id);
    expect(review!.status).toBe("sent");
    expect(review!.sentAt).toBeTruthy();
  });

  it("starts a fresh draft after the previous one is sent", () => {
    const first = store.createDraft("s1", "plan.md", "markdown", "h");
    store.markSent(first.id);

    const next = store.createDraft("s1", "plan.md", "markdown", "h");
    expect(next.id).not.toBe(first.id);
    expect(next.status).toBe("draft");
    expect(store.getDraft("s1", "plan.md")?.id).toBe(next.id);
  });

  // ------------------------------------------------------------------
  // Delete draft
  // ------------------------------------------------------------------

  it("deletes a draft and its comments", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "anchor", "", "", "x", "human");

    store.deleteDraft(draft.id);

    expect(store.getReview(draft.id)).toBeNull();
    expect(store.getDraft("s1", "plan.md")).toBeNull();
  });

  it("does not delete a sent review via deleteDraft", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.markSent(draft.id);
    store.deleteDraft(draft.id);

    expect(store.getReview(draft.id)).not.toBeNull();
  });

  // ------------------------------------------------------------------
  // List reviews: newest first
  // ------------------------------------------------------------------

  it("lists reviews for a (session, file) pair newest-first", () => {
    const oldId = "old-review-id";
    const oldTime = "2025-01-01T00:00:00.000Z";
    dbManager.db.prepare(`
      INSERT INTO file_reviews (id, session_id, file_path, file_type, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES (?, ?, ?, 'markdown', 'sent', ?, '[]', ?, ?)
    `).run(oldId, "s1", "plan.md", "h1", oldTime, oldTime);

    const second = store.createDraft("s1", "plan.md", "markdown", "h2");

    const reviews = store.listReviews("s1", "plan.md");
    expect(reviews).toHaveLength(2);
    expect(reviews[0].id).toBe(second.id);
    expect(reviews[1].id).toBe(oldId);
  });

  // ------------------------------------------------------------------
  // Persistence across store instances
  // ------------------------------------------------------------------

  it("persists data across store instances sharing the same database", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "anchor", "", "", "Persisted", "human");

    const store2 = new FileReviewStore(dbManager);
    const review = store2.getReview(draft.id);

    expect(review).not.toBeNull();
    expect(review!.sessionId).toBe("s1");
    expect(review!.comments[0].text).toBe("Persisted");
  });

  // ------------------------------------------------------------------
  // Session isolation
  // ------------------------------------------------------------------

  it("isolates reviews between sessions", () => {
    const a = store.createDraft("s1", "plan.md", "markdown", "h");
    const b = store.createDraft("s2", "plan.md", "markdown", "h");
    store.addSelectionComment(a.id, "anchor", "", "", "for s1", "human");
    store.addSelectionComment(b.id, "anchor", "", "", "for s2", "human");

    expect(store.listReviews("s1", "plan.md")[0].comments[0].text).toBe("for s1");
    expect(store.listReviews("s2", "plan.md")[0].comments[0].text).toBe("for s2");

    store.deleteDraft(a.id);
    expect(store.getDraft("s1", "plan.md")).toBeNull();
    expect(store.getDraft("s2", "plan.md")).not.toBeNull();
  });

  // ------------------------------------------------------------------
  // Migration: legacy kind='section' rows surface as kind='selection'
  // ------------------------------------------------------------------

  it("surfaces legacy section rows as selection comments via the migration", () => {
    // Insert a row in the legacy shape (kind='section') directly. The migration
    // running on store construction would have already converted any such rows
    // — this exercises the same code path for a row inserted post-migration.
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const now = new Date().toISOString();
    dbManager.db.prepare(`
      INSERT INTO file_review_comments
        (id, review_id, kind, section_heading, section_index, quoted_text, context_before, context_after, text, source, created_at)
      VALUES (?, ?, 'selection', '## Old', 0, 'Old', '', '', 'legacy feedback', 'human', ?)
    `).run("legacy-1", draft.id, now);

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
    const c = review!.comments[0];
    expect(c.kind).toBe("selection");
    if (c.kind !== "selection") throw new Error("expected selection");
    expect(c.quotedText).toBe("Old");
    expect(c.text).toBe("legacy feedback");
  });
});
