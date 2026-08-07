import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseManager } from "./database.js";
import { REPO_COLOR_ASSIGNMENT_ORDER } from "./repo-colors.js";

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

/**
 * docs/254 — the color_index migration backfills existing repos so a workspace
 * that upgrades into the sidebar's per-repo edge doesn't come up with every
 * group uncolored.
 *
 * Unlike the two suites above, this one runs the REAL migration rather than a
 * copy of its logic: it opens a database, rewinds `user_version` past the
 * color_index step, drops the column, seeds pre-migration rows, and re-opens.
 * A copied helper would stay green if the shipped migration were changed to
 * assign every row 0 or to skip the update entirely — which is exactly the
 * class of mistake a migration test exists to catch.
 */
describe("docs/254 — repo color_index backfill (real migration)", () => {
  let file: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shipit-migration-"));
    file = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Open the db, undo BOTH color_index migrations (the backfill and the
   * re-spread that follows it), seed rows as they would have existed before
   * them, and hand back the version to re-run from.
   *
   * Both, because they are one upgrade from the user's side: a workspace that
   * has never seen either arrives at the colors a fresh one would have.
   */
  function rewindPastColorMigration(seed: (db: DatabaseManager["db"]) => void): number {
    const m = new DatabaseManager(file);
    const version = m.db.pragma("user_version", { simple: true }) as number;
    m.db.exec("ALTER TABLE repos DROP COLUMN color_index");
    seed(m.db);
    m.db.pragma(`user_version = ${version - COLOR_MIGRATIONS}`);
    m.close();
    return version;
  }

  /** Backfill + re-spread. */
  const COLOR_MIGRATIONS = 2;
  /** What the pair produces for the first N repos in display order. */
  const spread = (n: number) => REPO_COLOR_ASSIGNMENT_ORDER.slice(0, n);

  const seedRepo = (db: DatabaseManager["db"], url: string, displayOrder: number | null, lastUsedAt = "2026-01-01") =>
    db.prepare(
      "INSERT INTO repos (url, added_at, last_used_at, status, display_order) VALUES (?, '2026-01-01', ?, 'ready', ?)",
    ).run(url, lastUsedAt, displayOrder);

  function colorsAfterMigration(urls: string[]): (number | null)[] {
    const m = new DatabaseManager(file);
    const out = urls.map(
      (u) => (m.db.prepare("SELECT color_index FROM repos WHERE url = ?").get(u) as { color_index: number | null }).color_index,
    );
    m.close();
    return out;
  }

  it("gives every pre-existing repo a distinct color", () => {
    rewindPastColorMigration((db) => {
      seedRepo(db, "a", 0);
      seedRepo(db, "b", 1);
      seedRepo(db, "c", 2);
    });
    expect(colorsAfterMigration(["a", "b", "c"])).toEqual(spread(3));
  });

  // Walks the sidebar's own display order, so the colors a user sees top-to-bottom
  // are the ones a fresh workspace would have been assigned.
  it("assigns in sidebar display order, not insertion order", () => {
    rewindPastColorMigration((db) => {
      seedRepo(db, "last", 2);
      seedRepo(db, "first", 0);
      seedRepo(db, "middle", 1);
    });
    expect(colorsAfterMigration(["first", "middle", "last"])).toEqual(spread(3));
  });

  it("falls back to last-used order for never-reordered repos", () => {
    rewindPastColorMigration((db) => {
      seedRepo(db, "older", null, "2026-01-01");
      seedRepo(db, "newer", null, "2026-06-01");
    });
    expect(colorsAfterMigration(["newer", "older"])).toEqual(spread(2));
  });

  // 18 repos can't all hold a distinct color, so the re-spread bails and these
  // are the backfill's own wrapped indices.
  it("wraps past the palette size rather than writing an unrenderable index", () => {
    rewindPastColorMigration((db) => {
      for (let i = 0; i < 18; i++) seedRepo(db, `r${i}`, i);
    });
    expect(colorsAfterMigration(["r15", "r16", "r17"])).toEqual([15, 0, 1]);
  });

  it("is a no-op on an empty repos table", () => {
    rewindPastColorMigration(() => {});
    const m = new DatabaseManager(file);
    expect((m.db.prepare("SELECT COUNT(*) c FROM repos").get() as { c: number }).c).toBe(0);
    m.close();
  });

  // Migrations run exactly once, but a crash mid-upgrade can leave the process
  // re-opening the same file — the result must not drift.
  it("leaves colors untouched when the database is re-opened", () => {
    rewindPastColorMigration((db) => {
      seedRepo(db, "a", 0);
      seedRepo(db, "b", 1);
    });
    expect(colorsAfterMigration(["a", "b"])).toEqual(spread(2));
    expect(colorsAfterMigration(["a", "b"])).toEqual(spread(2));
  });

  /**
   * The re-spread's guard. It runs over rows that ALREADY have colors — from
   * the backfill, or assigned by a build that walked the palette in order — so
   * it has to tell "nobody has touched these" from "someone used the picker",
   * with nothing recording which. The proxy is the shape of the value set: the
   * old scheme could only ever produce the contiguous prefix {0..N-1}, so
   * anything else means a human chose it and the workspace is left alone.
   *
   * These rewind only the re-spread, seeding color_index by hand — that's the
   * state the guard actually inspects, and it isn't reachable through the
   * backfill.
   */
  describe("re-spread guard", () => {
    function rewindPastRespread(colors: (number | null)[]): (number | null)[] {
      const urls = colors.map((_, i) => `r${i}`);
      const m = new DatabaseManager(file);
      const version = m.db.pragma("user_version", { simple: true }) as number;
      colors.forEach((c, i) => {
        seedRepo(m.db, urls[i], i);
        m.db.prepare("UPDATE repos SET color_index = ? WHERE url = ?").run(c, urls[i]);
      });
      m.db.pragma(`user_version = ${version - 1}`);
      m.close();
      return colorsAfterMigration(urls);
    }

    it("re-spreads a workspace still on the sequential colors", () => {
      expect(rewindPastRespread([0, 1, 2])).toEqual(spread(3));
    });

    // The guard reads the value SET, not each row's position, so a workspace
    // whose url→color mapping no longer matches display order is still
    // re-spread. Both a sidebar reorder and a manual swap of two repos' colors
    // produce this state and the stored data cannot tell them apart — see the
    // note on the migration itself.
    it("re-spreads a workspace whose colors no longer match display order", () => {
      expect(rewindPastRespread([2, 0, 1])).toEqual([
        REPO_COLOR_ASSIGNMENT_ORDER[2], REPO_COLOR_ASSIGNMENT_ORDER[0], REPO_COLOR_ASSIGNMENT_ORDER[1],
      ]);
    });

    // A picked color outranks a tidy palette — leave the WHOLE workspace alone
    // rather than re-spreading around the one row we can't move.
    it("leaves a workspace alone once someone has used the picker", () => {
      expect(rewindPastRespread([0, 1, 11])).toEqual([0, 1, 11]);
    });

    it("leaves duplicates alone — the old scheme never produced them", () => {
      expect(rewindPastRespread([0, 0, 1])).toEqual([0, 0, 1]);
    });

    it("leaves a workspace larger than the palette alone", () => {
      const many = Array.from({ length: 17 }, (_, i) => i % 16);
      expect(rewindPastRespread(many)).toEqual(many);
    });

    it("skips a row that never got a color rather than writing undefined", () => {
      expect(rewindPastRespread([0, null])).toEqual([0, null]);
    });

    it("is a no-op on an empty repos table", () => {
      expect(rewindPastRespread([])).toEqual([]);
    });

    // It runs once, but re-opening the file must not walk the permutation again
    // — that would keep shuffling colors on every boot.
    it("does not re-apply on re-open", () => {
      expect(rewindPastRespread([0, 1, 2])).toEqual(spread(3));
      expect(colorsAfterMigration(["r0", "r1", "r2"])).toEqual(spread(3));
    });
  });
});
