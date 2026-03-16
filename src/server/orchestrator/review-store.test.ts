import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ReviewStore } from "./review-store.js";

describe("ReviewStore", () => {
  let dbManager: DatabaseManager;
  let store: ReviewStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    store = new ReviewStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  // ------------------------------------------------------------------
  // Create draft
  // ------------------------------------------------------------------

  it("creates a draft with correct fields including docSnapshotHash and sectionHeadings", () => {
    const draft = store.createDraft("feat-1", "docs/001-foo/plan.md", "abc123hash", [
      "Overview",
      "Architecture",
      "API",
    ]);

    expect(draft.featureId).toBe("feat-1");
    expect(draft.planPath).toBe("docs/001-foo/plan.md");
    expect(draft.status).toBe("draft");
    expect(draft.docSnapshotHash).toBe("abc123hash");
    expect(draft.sectionHeadings).toEqual(["Overview", "Architecture", "API"]);
    expect(draft.comments).toEqual([]);
    expect(draft.id).toBeTruthy();
    expect(draft.createdAt).toBeTruthy();
    expect(draft.updatedAt).toBeTruthy();
    expect(draft.sentAt).toBeUndefined();
    expect(draft.sentToSessionId).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // One draft per feature
  // ------------------------------------------------------------------

  it("returns the existing draft when creating a second for the same feature", () => {
    const first = store.createDraft("feat-1", "docs/001/plan.md", "hash1", ["A"]);
    const second = store.createDraft("feat-1", "docs/001/plan.md", "hash2", ["B"]);

    expect(second.id).toBe(first.id);
    expect(second.docSnapshotHash).toBe("hash1");
    expect(second.sectionHeadings).toEqual(["A"]);
  });

  // ------------------------------------------------------------------
  // Add comment
  // ------------------------------------------------------------------

  it("adds a comment with correct ID, source, and section info", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["Intro", "Details"]);
    const comment = store.addComment("feat-1", draft.id, {
      sectionHeading: "Intro",
      sectionIndex: 0,
      text: "Needs more detail",
      source: "human",
    });

    expect(comment.id).toBeTruthy();
    expect(comment.sectionHeading).toBe("Intro");
    expect(comment.sectionIndex).toBe(0);
    expect(comment.text).toBe("Needs more detail");
    expect(comment.source).toBe("human");

    // Verify it shows up in the review
    const review = store.getReview("feat-1", draft.id);
    expect(review).not.toBeNull();
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].id).toBe(comment.id);
  });

  // ------------------------------------------------------------------
  // Update comment
  // ------------------------------------------------------------------

  it("updates comment text and preserves other fields", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["S1"]);
    const comment = store.addComment("feat-1", draft.id, {
      sectionHeading: "S1",
      sectionIndex: 0,
      text: "Original text",
      source: "human",
    });

    store.updateComment("feat-1", draft.id, comment.id, "Updated text");

    const review = store.getReview("feat-1", draft.id);
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].text).toBe("Updated text");
    expect(review!.comments[0].sectionHeading).toBe("S1");
    expect(review!.comments[0].sectionIndex).toBe(0);
    expect(review!.comments[0].source).toBe("human");
    expect(review!.comments[0].id).toBe(comment.id);
  });

  // ------------------------------------------------------------------
  // Delete comment
  // ------------------------------------------------------------------

  it("deletes a comment without affecting other comments", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["A", "B"]);
    const c1 = store.addComment("feat-1", draft.id, {
      sectionHeading: "A",
      sectionIndex: 0,
      text: "Comment one",
      source: "human",
    });
    const c2 = store.addComment("feat-1", draft.id, {
      sectionHeading: "B",
      sectionIndex: 1,
      text: "Comment two",
      source: "ai",
    });

    store.deleteComment("feat-1", draft.id, c1.id);

    const review = store.getReview("feat-1", draft.id);
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].id).toBe(c2.id);
    expect(review!.comments[0].text).toBe("Comment two");
  });

  // ------------------------------------------------------------------
  // Mark sent
  // ------------------------------------------------------------------

  it("marks a review as sent with status, sessionId, and sentAt", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["S"]);
    store.addComment("feat-1", draft.id, {
      sectionHeading: "S",
      sectionIndex: 0,
      text: "Fix this",
      source: "human",
    });

    store.markSent("feat-1", draft.id, "session-42");

    const review = store.getReview("feat-1", draft.id);
    expect(review).not.toBeNull();
    expect(review!.status).toBe("sent");
    expect(review!.sentToSessionId).toBe("session-42");
    expect(review!.sentAt).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // Delete draft
  // ------------------------------------------------------------------

  it("deletes a draft and its comments", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["S"]);
    store.addComment("feat-1", draft.id, {
      sectionHeading: "S",
      sectionIndex: 0,
      text: "A comment",
      source: "human",
    });

    store.deleteDraft("feat-1", draft.id);

    expect(store.getReview("feat-1", draft.id)).toBeNull();
    expect(store.getDraft("feat-1")).toBeNull();
  });

  // ------------------------------------------------------------------
  // List reviews: newest first
  // ------------------------------------------------------------------

  it("lists reviews for a feature with newest first", () => {
    // Insert a review with an older timestamp directly to avoid timing issues
    const oldId = "old-review-id";
    const oldTime = "2025-01-01T00:00:00.000Z";
    dbManager.db.prepare(`
      INSERT INTO doc_reviews (id, feature_id, plan_path, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES (?, ?, ?, 'sent', ?, ?, ?, ?)
    `).run(oldId, "feat-1", "plan.md", "h1", JSON.stringify(["A"]), oldTime, oldTime);

    // Create a new draft — its created_at will be "now", which is after oldTime
    const second = store.createDraft("feat-1", "plan.md", "h2", ["B"]);

    const reviews = store.listReviews("feat-1");
    expect(reviews).toHaveLength(2);
    // newest first
    expect(reviews[0].id).toBe(second.id);
    expect(reviews[1].id).toBe(oldId);
  });

  // ------------------------------------------------------------------
  // Persistence across store instances
  // ------------------------------------------------------------------

  it("persists data across store instances sharing the same database", () => {
    const draft = store.createDraft("feat-1", "plan.md", "h", ["S"]);
    store.addComment("feat-1", draft.id, {
      sectionHeading: "S",
      sectionIndex: 0,
      text: "Persisted comment",
      source: "human",
    });

    // Create a new store instance from the same dbManager
    const store2 = new ReviewStore(dbManager);
    const review = store2.getReview("feat-1", draft.id);

    expect(review).not.toBeNull();
    expect(review!.featureId).toBe("feat-1");
    expect(review!.docSnapshotHash).toBe("h");
    expect(review!.comments).toHaveLength(1);
    expect(review!.comments[0].text).toBe("Persisted comment");
  });

  // ------------------------------------------------------------------
  // Isolation between features
  // ------------------------------------------------------------------

  it("isolates reviews between different features", () => {
    const draft1 = store.createDraft("feat-1", "plan1.md", "h1", ["X"]);
    const draft2 = store.createDraft("feat-2", "plan2.md", "h2", ["Y"]);

    store.addComment("feat-1", draft1.id, {
      sectionHeading: "X",
      sectionIndex: 0,
      text: "Comment for feat-1",
      source: "human",
    });

    store.addComment("feat-2", draft2.id, {
      sectionHeading: "Y",
      sectionIndex: 0,
      text: "Comment for feat-2",
      source: "ai",
    });

    // Each feature only sees its own reviews
    const reviews1 = store.listReviews("feat-1");
    const reviews2 = store.listReviews("feat-2");
    expect(reviews1).toHaveLength(1);
    expect(reviews2).toHaveLength(1);
    expect(reviews1[0].comments[0].text).toBe("Comment for feat-1");
    expect(reviews2[0].comments[0].text).toBe("Comment for feat-2");

    // Deleting one feature's draft doesn't affect the other
    store.deleteDraft("feat-1", draft1.id);
    expect(store.getDraft("feat-1")).toBeNull();
    expect(store.getDraft("feat-2")).not.toBeNull();
    expect(store.listReviews("feat-2")[0].comments).toHaveLength(1);
  });
});
