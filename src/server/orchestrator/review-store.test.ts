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

  it("adds a selection-anchored comment with the right kind and quoted text", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const comment = store.addSelectionComment(
      draft.id,
      "The introduction",
      "## Intro\n\n",
      " section explains",
      "Needs more detail",
    );

    expect(comment.kind).toBe("selection");
    if (comment.kind !== "selection") throw new Error("expected selection");
    expect(comment.quotedText).toBe("The introduction");
    expect(comment.contextBefore).toBe("## Intro\n\n");
    expect(comment.contextAfter).toBe(" section explains");
    expect(comment.text).toBe("Needs more detail");

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].id).toBe(comment.id);
  });

  it("adds a line-anchored comment with the right kind and line", () => {
    const draft = store.createDraft("s1", "src/foo.ts", "code", "h");
    const comment = store.addLineComment(draft.id, 42, "SQL injection risk");

    expect(comment.kind).toBe("line");
    if (comment.kind !== "line") throw new Error("expected line");
    expect(comment.line).toBe(42);
    expect(comment.text).toBe("SQL injection risk");

    const review = store.getReview(draft.id);
    expect(review!.comments).toHaveLength(1);
  });

  it("supports both line and selection comments inside the same review", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "the intro", "", "", "selection one");
    store.addLineComment(draft.id, 1, "line one");

    const review = store.getReview(draft.id);
    const kinds = review!.comments.map((c) => c.kind).sort();
    expect(kinds).toEqual(["line", "selection"]);
  });

  // ------------------------------------------------------------------
  // Update comment
  // ------------------------------------------------------------------

  it("updates comment text and preserves anchor fields", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const comment = store.addSelectionComment(draft.id, "anchored phrase", "", "", "Original");
    store.updateComment(draft.id, comment.id, "Updated");

    const review = store.getReview(draft.id);
    expect(review!.comments[0].text).toBe("Updated");
    if (review!.comments[0].kind !== "selection") throw new Error("expected selection");
    expect(review!.comments[0].quotedText).toBe("anchored phrase");
  });

  // ------------------------------------------------------------------
  // Delete comment
  // ------------------------------------------------------------------

  it("deletes a comment without affecting siblings", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const c1 = store.addSelectionComment(draft.id, "one", "", "", "first");
    const c2 = store.addSelectionComment(draft.id, "two", "", "", "second");

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
    store.addSelectionComment(draft.id, "anchor", "", "", "feedback");

    store.markSent(draft.id);

    const review = store.getReview(draft.id);
    expect(review!.status).toBe("sent");
    expect(review!.sentAt).toBeTruthy();
  });

  // docs/260 — the send dialog's note rides along with markSent and comes back
  // on the sent review, which is what "Past reviews" reads.
  it("stores the send note on the sent review", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "anchor", "", "", "feedback");

    store.markSent(draft.id, "  Keep the structure.  ");

    expect(store.getReview(draft.id)!.note).toBe("Keep the structure.");
  });

  it("stores no note when the note is absent or whitespace only", () => {
    const a = store.createDraft("s1", "a.md", "markdown", "h");
    store.markSent(a.id);
    expect(store.getReview(a.id)!.note).toBeUndefined();

    const b = store.createDraft("s1", "b.md", "markdown", "h");
    store.markSent(b.id, "   \n  ");
    expect(store.getReview(b.id)!.note).toBeUndefined();
  });

  // The atomic half of the double-send guard: sendReview's status check happens
  // before an awaited file read, so only this UPDATE can separate two
  // concurrent sends of the same draft.
  it("refuses to mark an already-sent review sent again", () => {
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    store.addSelectionComment(draft.id, "anchor", "", "", "feedback");

    expect(store.markSent(draft.id, "first")).toBe(true);
    expect(store.markSent(draft.id, "second")).toBe(false);
    // …and the loser did not overwrite the winner's note.
    expect(store.getReview(draft.id)!.note).toBe("first");
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
    store.addSelectionComment(draft.id, "anchor", "", "", "x");

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
    store.addSelectionComment(draft.id, "anchor", "", "", "Persisted");

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
    store.addSelectionComment(a.id, "anchor", "", "", "for s1");
    store.addSelectionComment(b.id, "anchor", "", "", "for s2");

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

  // ------------------------------------------------------------------
  // Vestigial `source` column (docs/203, docs/220)
  // ------------------------------------------------------------------

  it("leaves the retained source column at its 'human' default on insert", () => {
    // The inserts omit `source`, which is still `NOT NULL` in SQLite. The
    // column default is what makes that legal — and what keeps a downgrade to
    // an older ShipIt (which reads the column) working. If a future schema
    // change drops the default, this test is the one that fails.
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    const selection = store.addSelectionComment(draft.id, "anchor", "", "", "note");
    const codeDraft = store.createDraft("s1", "src/foo.ts", "code", "h");
    const line = store.addLineComment(codeDraft.id, 3, "note");

    const sources = dbManager.db.prepare(
      "SELECT id, source FROM file_review_comments WHERE id IN (?, ?)",
    ).all(selection.id, line.id) as { id: string; source: string }[];

    expect(sources).toHaveLength(2);
    for (const row of sources) expect(row.source).toBe("human");
  });

  it("reads a historical source='ai' row back as an ordinary comment", () => {
    // Sent reviews written before the AI write path was removed can still hold
    // `source = 'ai'` rows (migration 21 swept only drafts). They carry no
    // author discriminator any more — they read back like any other comment.
    const draft = store.createDraft("s1", "plan.md", "markdown", "h");
    dbManager.db.prepare(`
      INSERT INTO file_review_comments
        (id, review_id, kind, quoted_text, context_before, context_after, text, source, created_at)
      VALUES (?, ?, 'selection', 'Old', '', '', 'robot said this', 'ai', ?)
    `).run("ai-1", draft.id, new Date().toISOString());

    const comment = store.getReview(draft.id)!.comments[0];
    expect(comment.text).toBe("robot said this");
    expect(comment).not.toHaveProperty("source");
  });
});
