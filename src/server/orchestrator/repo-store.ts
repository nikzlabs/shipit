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

  /** List all repos sorted by lastUsedAt descending. */
  list(): RepoInfo[] {
    const rows = this.db.prepare(
      "SELECT * FROM repos ORDER BY last_used_at DESC, rowid DESC",
    ).all() as RepoRow[];
    return rows.map((r) => this.fromRow(r));
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
