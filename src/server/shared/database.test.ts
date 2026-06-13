import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "./database.js";

/**
 * Migration 21 (docs/151) — the agent-reviews tables ship alongside a
 * one-shot sweep that deletes `source = "ai"` rows from draft `file_reviews`
 * and removes any draft that's left empty after the sweep. Sent reviews are
 * untouched (the user explicitly clicked Send on them, so the history is
 * still meaningful). The sweep is idempotent — running it again after the
 * tables are in place is a no-op because new AI submissions land in
 * `agent_reviews`, not `file_review_comments`.
 *
 * The DatabaseManager constructor runs migrations in order, so we exercise
 * the sweep by re-running its DELETE statements after seeding the kind of
 * mixed-source draft rows the bug accumulated in production. That mirrors
 * what happens on first boot after the migration lands.
 */

const MIGRATION_21_SWEEP = `
  DELETE FROM file_review_comments
   WHERE source = 'ai'
     AND review_id IN (
       SELECT id FROM file_reviews WHERE status = 'draft'
     );

  DELETE FROM file_reviews
   WHERE status = 'draft'
     AND id NOT IN (SELECT review_id FROM file_review_comments);
`;

describe("Migration 21 — agent review tables + AI-draft sweep", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  it("creates the agent_reviews and agent_review_comments tables", () => {
    const tables = dbManager.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_review%'",
    ).all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(["agent_review_comments", "agent_reviews"]);
  });

  it("deletes source='ai' rows from draft file_reviews and drops drafts left empty", () => {
    const db = dbManager.db;
    // Seed two drafts and one sent review with mixed sources.
    db.prepare(`
      INSERT INTO file_reviews (id, session_id, file_path, file_type, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES
        ('draft-1', 's1', 'docs/a.md', 'markdown', 'draft', '', '[]', '2026-01-01', '2026-01-01'),
        ('draft-2', 's1', 'docs/b.md', 'markdown', 'draft', '', '[]', '2026-01-01', '2026-01-01'),
        ('sent-1',  's1', 'docs/c.md', 'markdown', 'sent',  '', '[]', '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO file_review_comments (id, review_id, kind, quoted_text, context_before, context_after, text, source, created_at)
      VALUES
        ('c1', 'draft-1', 'selection', 'q', '', '', 'ai finding',    'ai',    '2026-01-01'),
        ('c2', 'draft-1', 'selection', 'q', '', '', 'human note',    'human', '2026-01-01'),
        ('c3', 'draft-2', 'selection', 'q', '', '', 'all-ai pile',   'ai',    '2026-01-01'),
        ('c4', 'sent-1',  'selection', 'q', '', '', 'kept sent ai',  'ai',    '2026-01-01'),
        ('c5', 'sent-1',  'selection', 'q', '', '', 'kept sent hum', 'human', '2026-01-01')
    `).run();

    // Run the sweep as it would on first boot after the migration lands.
    db.exec(MIGRATION_21_SWEEP);

    const remainingComments = db.prepare("SELECT id, source, review_id FROM file_review_comments ORDER BY id").all() as { id: string; source: string; review_id: string }[];
    // draft-1's AI comment is gone but its human comment stays. draft-2's
    // only comment was AI so the whole draft+comment pair is gone. Sent
    // review keeps both its rows.
    expect(remainingComments.map((c) => c.id)).toEqual(["c2", "c4", "c5"]);

    const remainingReviews = db.prepare("SELECT id, status FROM file_reviews ORDER BY id").all() as { id: string; status: string }[];
    expect(remainingReviews.map((r) => r.id)).toEqual(["draft-1", "sent-1"]);
  });

  it("re-running the sweep is a no-op (idempotent)", () => {
    const db = dbManager.db;
    db.prepare(`
      INSERT INTO file_reviews (id, session_id, file_path, file_type, status, doc_snapshot_hash, section_headings, created_at, updated_at)
      VALUES ('draft-1', 's1', 'docs/a.md', 'markdown', 'draft', '', '[]', '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO file_review_comments (id, review_id, kind, quoted_text, context_before, context_after, text, source, created_at)
      VALUES ('c1', 'draft-1', 'selection', 'q', '', '', 'human note', 'human', '2026-01-01')
    `).run();

    db.exec(MIGRATION_21_SWEEP);
    db.exec(MIGRATION_21_SWEEP);

    const reviews = db.prepare("SELECT id FROM file_reviews").all() as { id: string }[];
    const comments = db.prepare("SELECT id FROM file_review_comments").all() as { id: string }[];
    expect(reviews.map((r) => r.id)).toEqual(["draft-1"]);
    expect(comments.map((c) => c.id)).toEqual(["c1"]);
  });
});

/**
 * docs/201 — the root_session_id migration backfills existing spawned rows by
 * walking each `parent_session_id` chain to its top. The migration's walk is
 * inline JS (not a single SQL string), so — mirroring the MIGRATION_21_SWEEP
 * pattern above — we replicate that exact walk here and assert it against
 * seeded pre-migration shapes (rows with a parent link but a NULL root).
 */
function runRootBackfill(db: DatabaseManager["db"]): void {
  const spawned = db
    .prepare("SELECT id, parent_session_id FROM sessions WHERE parent_session_id IS NOT NULL")
    .all() as { id: string; parent_session_id: string }[];
  const parentOf = new Map<string, string>();
  for (const r of spawned) parentOf.set(r.id, r.parent_session_id);
  const update = db.prepare("UPDATE sessions SET root_session_id = ? WHERE id = ?");
  for (const r of spawned) {
    const seen = new Set<string>([r.id]);
    let cursor = r.parent_session_id;
    let root = cursor;
    while (parentOf.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentOf.get(cursor)!;
      root = cursor;
    }
    update.run(root, r.id);
  }
}

describe("docs/201 — root_session_id backfill walk", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
  });

  afterEach(() => {
    dbManager.close();
  });

  const seed = (id: string, parent: string | null) =>
    dbManager.db
      .prepare(
        "INSERT INTO sessions (id, title, created_at, last_used_at, parent_session_id) VALUES (?, ?, '2026-01-01', '2026-01-01', ?)",
      )
      .run(id, id, parent);

  const rootOf = (id: string) =>
    (dbManager.db.prepare("SELECT root_session_id FROM sessions WHERE id = ?").get(id) as { root_session_id: string | null })
      .root_session_id;

  it("stamps every descendant in a chain with the top-level ancestor", () => {
    // root → child → grand → great, plus a second direct child (sibling) and an
    // unrelated top-level session.
    seed("root", null);
    seed("child", "root");
    seed("grand", "child");
    seed("great", "grand");
    seed("sibling", "root");
    seed("other", null);

    runRootBackfill(dbManager.db);

    // Every spawned descendant resolves to the SAME top-level root, regardless
    // of depth — this is what lets the sidebar group the whole brood.
    expect(rootOf("child")).toBe("root");
    expect(rootOf("grand")).toBe("root");
    expect(rootOf("great")).toBe("root");
    expect(rootOf("sibling")).toBe("root");
    // Top-level sessions keep a NULL root (they ARE their own root).
    expect(rootOf("root")).toBeNull();
    expect(rootOf("other")).toBeNull();
  });

  it("is idempotent — re-running produces the same roots", () => {
    seed("root", null);
    seed("child", "root");
    seed("grand", "child");

    runRootBackfill(dbManager.db);
    runRootBackfill(dbManager.db);

    expect(rootOf("child")).toBe("root");
    expect(rootOf("grand")).toBe("root");
  });

  it("terminates on a legacy parent-link cycle instead of looping forever", () => {
    // a → b → a. Such a cycle shouldn't exist (the spawn-self-parent bug is
    // fixed), but the visited-set guard must keep the walk bounded if one does.
    seed("a", "b");
    seed("b", "a");

    expect(() => runRootBackfill(dbManager.db)).not.toThrow();
    // Both rows get a (bounded) root within the cycle — the point is the walk
    // returns at all rather than spinning.
    expect(rootOf("a")).not.toBeNull();
    expect(rootOf("b")).not.toBeNull();
  });
});
