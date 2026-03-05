import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

export type DatabaseInstance = BetterSqlite3.Database;

/**
 * Schema migration: a function that receives the database and applies changes.
 * Migrations are run in order by index (0-based). Each migration runs inside
 * a transaction managed by DatabaseManager.
 */
export type Migration = (db: DatabaseInstance) => void;

const MIGRATIONS: Migration[] = [
  // Migration 0: initial schema — all tables
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_use TEXT,
        images TEXT,
        files TEXT,
        is_error INTEGER DEFAULT 0,
        commit_hash TEXT,
        parent_commit_hash TEXT,
        in_progress INTEGER DEFAULT 0,
        tool_results TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      CREATE TABLE IF NOT EXISTS usage_turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_turns(session_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_session_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        workspace_dir TEXT,
        remote_url TEXT,
        conversation_replay TEXT,
        archived INTEGER DEFAULT 0,
        warm INTEGER DEFAULT 0,
        branch TEXT,
        session_type TEXT,
        branch_renamed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_remote ON sessions(remote_url);
      CREATE INDEX IF NOT EXISTS idx_sessions_warm ON sessions(warm) WHERE warm = 1;

      CREATE TABLE IF NOT EXISTS repos (
        url TEXT PRIMARY KEY,
        added_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'cloning',
        warm_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS deploy_configs (
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        credentials TEXT NOT NULL,
        project_name TEXT,
        PRIMARY KEY (session_id, target_id)
      );

      CREATE TABLE IF NOT EXISTS deploy_history (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        url TEXT NOT NULL,
        commit_hash TEXT,
        commit_message TEXT,
        timestamp TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        PRIMARY KEY (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_history_session ON deploy_history(session_id);
    `);
  },
];

export class DatabaseManager {
  readonly db: DatabaseInstance;

  constructor(dbPath = "/workspace/.shipit.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.runMigrations();
  }

  private runMigrations(): void {
    // Use a simple user_version pragma to track migration state
    const currentVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;

    if (currentVersion >= MIGRATIONS.length) return;

    const migrate = this.db.transaction(() => {
      for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        MIGRATIONS[i](this.db);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    });

    migrate();
  }

  /** Delete all rows from all tables (used by full reset). */
  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM usage_turns").run();
      this.db.prepare("DELETE FROM sessions").run();
      this.db.prepare("DELETE FROM repos").run();
      this.db.prepare("DELETE FROM deploy_configs").run();
      this.db.prepare("DELETE FROM deploy_history").run();
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
