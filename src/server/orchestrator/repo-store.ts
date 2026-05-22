import type { RepoInfo } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";

interface RepoRow {
  url: string;
  added_at: string;
  last_used_at: string;
  status: string;
  warm_session_id: string | null;
}

export class RepoStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  private fromRow(row: RepoRow): RepoInfo {
    const info: RepoInfo = {
      url: row.url,
      addedAt: row.added_at,
      lastUsedAt: row.last_used_at,
      status: row.status as RepoInfo["status"],
    };
    if (row.warm_session_id) info.warmSessionId = row.warm_session_id;
    return info;
  }

  /** Add a repo. Sets status to "cloning". Returns the new RepoInfo. */
  add(url: string): RepoInfo {
    const existing = this.get(url);
    if (existing) {
      this.db.prepare("UPDATE repos SET last_used_at = ? WHERE url = ?").run(new Date().toISOString(), url);
      return this.get(url)!;
    }
    const now = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO repos (url, added_at, last_used_at, status) VALUES (?, ?, ?, 'cloning')",
    ).run(url, now, now);
    return this.get(url)!;
  }

  /** Flip status to "ready" after clone completes. */
  setReady(url: string): void {
    this.db.prepare("UPDATE repos SET status = 'ready' WHERE url = ?").run(url);
  }

  /** Store the warm session's ID. */
  setWarmSessionId(url: string, sessionId: string | undefined): void {
    this.db.prepare("UPDATE repos SET warm_session_id = ? WHERE url = ?").run(sessionId ?? null, url);
  }

  /** Update lastUsedAt timestamp. */
  touch(url: string): void {
    this.db.prepare("UPDATE repos SET last_used_at = ? WHERE url = ?").run(new Date().toISOString(), url);
  }

  /** Remove a repo. */
  remove(url: string): boolean {
    const result = this.db.prepare("DELETE FROM repos WHERE url = ?").run(url);
    return result.changes > 0;
  }

  /**
   * List all repos. Sort order:
   *   1. `display_order` ASC when set (user-chosen order from drag-and-drop).
   *   2. `last_used_at` DESC for repos that have never been reordered (NULL
   *      display_order sorts last via the CASE WHEN expression).
   *   3. `rowid` DESC as a stable tiebreaker.
   * Once the user reorders, `setOrder` assigns a non-NULL value to every repo,
   * so display_order becomes fully authoritative from that point on.
   */
  list(): RepoInfo[] {
    const rows = this.db.prepare(
      `SELECT * FROM repos
       ORDER BY CASE WHEN display_order IS NULL THEN 1 ELSE 0 END,
                display_order ASC,
                last_used_at DESC,
                rowid DESC`,
    ).all() as RepoRow[];
    return rows.map((r) => this.fromRow(r));
  }

  /**
   * Assign explicit ordering to the given urls (0-based index). Repos not
   * present in the urls list keep their existing display_order (or NULL if
   * never set) — they'll continue to sort after the ordered set.
   *
   * Runs in a transaction so concurrent reorders don't see a half-applied
   * state. Unknown urls are silently ignored — the client can submit a list
   * that's slightly out-of-date without erroring out.
   */
  setOrder(urls: string[]): void {
    const update = this.db.prepare("UPDATE repos SET display_order = ? WHERE url = ?");
    const tx = this.db.transaction((urls: string[]) => {
      for (let i = 0; i < urls.length; i++) {
        update.run(i, urls[i]);
      }
    });
    tx(urls);
  }

  /** Get a single repo by URL. */
  get(url: string): RepoInfo | undefined {
    const row = this.db.prepare("SELECT * FROM repos WHERE url = ?").get(url) as RepoRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  /** Check if a repo URL is already tracked. */
  has(url: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM repos WHERE url = ? LIMIT 1").get(url);
    return row !== undefined;
  }

  /** Clear all repo data. */
  clear(): void {
    this.db.prepare("DELETE FROM repos").run();
  }
}
