import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLOR_BACKFILL_MIGRATION, DatabaseManager } from "./database.js";
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
    // Rewind to the backfill's own index, NOT `version - 2`. Counting back from
    // the tip silently re-targets the wrong migrations the moment one is
    // appended — which is what happened when docs/252 added its columns and this
    // suite started re-running the re-spread against a dropped column.
    // Everything after the backfill re-runs too, so a migration appended later
    // must tolerate that (the docs/252 one guards its ADD COLUMNs for exactly
    // this reason).
    m.db.pragma(`user_version = ${COLOR_BACKFILL_MIGRATION}`);
    m.close();
    return version;
  }
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

  // 18 repos can't all hold a distinct color. The re-spread is a straight
  // permutation, so the backfill's wrap survives it: r16 repeats r0's color
  // before and after, just a different one.
  it("wraps past the palette size rather than writing an unrenderable index", () => {
    rewindPastColorMigration((db) => {
      for (let i = 0; i < 18; i++) seedRepo(db, `r${i}`, i);
    });
    expect(colorsAfterMigration(["r15", "r16", "r17"])).toEqual([
      REPO_COLOR_ASSIGNMENT_ORDER[15], REPO_COLOR_ASSIGNMENT_ORDER[0], REPO_COLOR_ASSIGNMENT_ORDER[1],
    ]);
    expect(colorsAfterMigration(["r0"])).toEqual([REPO_COLOR_ASSIGNMENT_ORDER[0]]);
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
   * The re-spread's gate.
   *
   * It rewrites colors, and a color is also something a user picks in Project
   * Settings — so the only question that matters is whether the values it finds
   * were machine-assigned or chosen. No property of the stored data answers
   * that: a user who swaps two repos' colors leaves exactly the contiguous
   * {0..N-1} set the backfill does, so a shape check would bless the swap and
   * overwrite it. The migration therefore doesn't infer — it gates on
   * `fromVersion`, rewriting only when the backfill ran in the SAME pass,
   * microseconds earlier, with no window for anyone to have picked anything.
   *
   * The deliberate cost: a workspace already on a build that had the backfill
   * keeps its adjacent hues. That case is the second test.
   *
   * These two also pin `COLOR_BACKFILL_MIGRATION` from both sides — set it too
   * high and the already-migrated case would re-spread; too low and every
   * upgrading case above would stop.
   */
  describe("re-spread gate", () => {
    /** Rewind ONLY the re-spread, leaving color_index populated as seeded. */
    function rewindPastRespread(colors: number[]): (number | null)[] {
      const urls = colors.map((_, i) => `r${i}`);
      const m = new DatabaseManager(file);
      const version = m.db.pragma("user_version", { simple: true }) as number;
      colors.forEach((c, i) => {
        seedRepo(m.db, urls[i], i);
        m.db.prepare("UPDATE repos SET color_index = ? WHERE url = ?").run(c, urls[i]);
      });
      // The step AFTER the backfill, addressed by index rather than by counting
      // back from the tip — see `rewindPastColorMigration`. `fromVersion` then
      // lands strictly above `COLOR_BACKFILL_MIGRATION`, which is the gate this
      // suite exists to pin.
      void version;
      m.db.pragma(`user_version = ${COLOR_BACKFILL_MIGRATION + 1}`);
      m.close();
      return colorsAfterMigration(urls);
    }

    // The whole point of the migration, restated at the gate: a database that
    // has never had the column gets both migrations, so it lands spread.
    it("re-spreads a workspace upgrading into the feature", () => {
      rewindPastColorMigration((db) => {
        seedRepo(db, "a", 0);
        seedRepo(db, "b", 1);
      });
      expect(colorsAfterMigration(["a", "b"])).toEqual(spread(2));
    });

    // …and a database that already ran the backfill on some earlier boot is
    // left exactly as it is, because by now any of those values could be a
    // deliberate pick. Sequential colors here are the SAME state the test above
    // re-spreads — only the version the pass started from differs.
    it("leaves a workspace that already had colors alone", () => {
      expect(rewindPastRespread([0, 1, 2])).toEqual([0, 1, 2]);
    });

    it("leaves a manually picked color alone", () => {
      expect(rewindPastRespread([0, 1, 11])).toEqual([0, 1, 11]);
    });

    // The case a shape check could not have distinguished: swapping two repos'
    // colors leaves the contiguous set intact, and is now safe purely because
    // the gate never looks at the values.
    it("leaves a swapped pair alone", () => {
      expect(rewindPastRespread([1, 0, 2])).toEqual([1, 0, 2]);
    });
  });
});

/**
 * docs/252 phase 1 — the selection-triple backfill.
 *
 * Runs the REAL migration, like the color suite above: it rewinds `user_version`
 * past this step, drops the four columns, seeds rows as they existed before it,
 * and re-opens. The billing mode decides what a user is billed, so a copied
 * helper that stayed green while the shipped rule changed would be worse than no
 * test at all.
 */
describe("docs/252 — model-selection backfill (real migration)", () => {
  let file: string;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shipit-252-"));
    file = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  interface Seed {
    id: string;
    agentId: string | null;
    model: string | null;
    routeKind: string | null;
    routeId: string | null;
  }

  function rewindAndSeed(seeds: Seed[]): void {
    const m = new DatabaseManager(file);
    const version = m.db.pragma("user_version", { simple: true }) as number;
    for (const column of [
      "service_id",
      "billing_mode",
      "provider_route_service_id",
      "provider_route_billing_mode",
    ]) {
      m.db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
    }
    for (const seed of seeds) {
      m.db
        .prepare(
          `INSERT INTO sessions (id, title, created_at, last_used_at, agent_id, model,
                                 provider_route_kind, provider_route_id)
           VALUES (?, ?, '2026-01-01', '2026-01-01', ?, ?, ?, ?)`,
        )
        .run(seed.id, seed.id, seed.agentId, seed.model, seed.routeKind, seed.routeId);
    }
    m.db.pragma(`user_version = ${version - 1}`);
    m.close();
  }

  function readBack(id: string) {
    const m = new DatabaseManager(file);
    const row = m.db
      .prepare(
        `SELECT service_id, billing_mode, provider_route_service_id, provider_route_billing_mode
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      service_id: string | null;
      billing_mode: string | null;
      provider_route_service_id: string | null;
      provider_route_billing_mode: string | null;
    };
    m.close();
    return row;
  }

  const seed = (over: Partial<Seed> & { id: string }): Seed => ({
    agentId: null,
    model: null,
    routeKind: null,
    routeId: null,
    ...over,
  });

  it("derives the service from the model, for both first-party vendors", () => {
    rewindAndSeed([
      seed({ id: "a", agentId: "claude", model: "claude-opus-5" }),
      seed({ id: "b", agentId: "codex", model: "gpt-5.6-sol" }),
    ]);
    expect(readBack("a").service_id).toBe("anthropic");
    expect(readBack("b").service_id).toBe("openai");
  });

  it("places a row by its model id, with no agent needed", () => {
    rewindAndSeed([
      seed({ id: "a", model: "claude-sonnet-5" }),
      seed({ id: "c", model: "gpt-5.4" }),
    ]);
    expect(readBack("a").service_id).toBe("anthropic");
    expect(readBack("c").service_id).toBe("openai");
  });

  it("refuses to place a model the catalogue does not offer", () => {
    // The invariant: a stored triple either names a real catalogue row or has no
    // service and mode at all. `sonnet` and `opus` are CLI aliases, and
    // `claude-opus-4-8` is retired — none is a catalogue model, so a
    // `(anthropic, sub, sonnet)` triple would name nothing and later phases
    // could resolve no endpoint from it. The `model` column is untouched, and
    // req 13's retirement map (phase 8) is what carries these forward.
    rewindAndSeed([
      seed({ id: "alias", agentId: "claude", model: "sonnet" }),
      seed({ id: "retired", agentId: "claude", model: "claude-opus-4-8" }),
      seed({ id: "versioned", agentId: "claude", model: "claude-sonnet-4-20250514" }),
    ]);
    for (const id of ["alias", "retired", "versioned"]) {
      expect(readBack(id).service_id, id).toBeNull();
      expect(readBack(id).billing_mode, id).toBeNull();
    }
  });

  it("places the retired unsuffixed GPT-5.6 slug, which the catalogue does carry", () => {
    // Old rows still hold it and the catalogue names a successor for it, so it
    // is placeable — unlike the aliases above.
    rewindAndSeed([seed({ id: "a", agentId: "codex", model: "gpt-5.6" })]);
    expect(readBack("a").service_id).toBe("openai");
  });

  it("classifies by route ID, not by route KIND — an env OAuth token is a SUBSCRIPTION", () => {
    // The bug the plan calls out explicitly: `claude-env-oauth` is a `reserved`
    // route carrying a quota-bearing subscription token. Reading `kind` would
    // bill those subscribers as metered and hide their quota.
    rewindAndSeed([
      seed({
        id: "envoauth",
        agentId: "claude",
        model: "claude-opus-5",
        routeKind: "reserved",
        routeId: "claude-env-oauth",
      }),
      seed({
        id: "apikey",
        agentId: "claude",
        model: "claude-opus-5",
        routeKind: "reserved",
        routeId: "claude-api-key",
      }),
      seed({
        id: "codexkey",
        agentId: "codex",
        model: "gpt-5.6-sol",
        routeKind: "reserved",
        routeId: "codex-api-key",
      }),
    ]);
    expect(readBack("envoauth").billing_mode).toBe("sub");
    expect(readBack("apikey").billing_mode).toBe("key");
    expect(readBack("codexkey").billing_mode).toBe("key");
  });

  it("treats every account route as a subscription", () => {
    rewindAndSeed([
      seed({
        id: "a",
        agentId: "claude",
        model: "claude-opus-5",
        routeKind: "account",
        routeId: "acct_1",
      }),
    ]);
    expect(readBack("a").billing_mode).toBe("sub");
  });

  it("defaults an evidence-free row to `sub`, which fails in the safe direction", () => {
    // A session wrongly on `sub` stops and says so; one wrongly on `key`
    // silently spends money.
    rewindAndSeed([seed({ id: "a", agentId: "claude", model: "claude-opus-5" })]);
    expect(readBack("a").billing_mode).toBe("sub");
  });

  it("stamps a pinned route with the pair it belongs to, and leaves an unpinned row null", () => {
    rewindAndSeed([
      seed({
        id: "pinned",
        agentId: "claude",
        model: "claude-opus-5",
        routeKind: "account",
        routeId: "acct_1",
      }),
      seed({ id: "unpinned", agentId: "claude", model: "claude-opus-5" }),
    ]);
    expect(readBack("pinned").provider_route_service_id).toBe("anthropic");
    expect(readBack("pinned").provider_route_billing_mode).toBe("sub");
    expect(readBack("unpinned").provider_route_service_id).toBeNull();
  });

  it("leaves a row with no model at all entirely alone", () => {
    // No evidence at all — inventing a service here would decide what the user
    // is billed from nothing. The next selection writes the triple instead.
    rewindAndSeed([seed({ id: "a", agentId: "claude" })]);
    const row = readBack("a");
    expect(row.service_id).toBeNull();
    expect(row.billing_mode).toBeNull();
  });
});
