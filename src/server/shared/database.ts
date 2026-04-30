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

    `);
  },
  // Migration 1: add merged_at timestamp for deferred post-merge archiving
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN merged_at TEXT");
  },
  // Migration 2: secrets table for per-repo environment variables (preview container isolation)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        repo_url TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (repo_url, key)
      );
      CREATE INDEX IF NOT EXISTS idx_secrets_repo ON secrets(repo_url);
    `);
  },
  // Migration 3: doc review tables for design doc review comments (049)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_reviews (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL,
        plan_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        doc_snapshot_hash TEXT NOT NULL,
        section_headings TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        sent_to_session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_doc_reviews_feature ON doc_reviews(feature_id);
      CREATE INDEX IF NOT EXISTS idx_doc_reviews_status ON doc_reviews(feature_id, status);

      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        section_heading TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        FOREIGN KEY (review_id) REFERENCES doc_reviews(id)
      );
      CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id);
    `);
  },
  // Migration 4: add model column to sessions for persisting model selection
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  },
  // Migration 5: drop legacy deploy tables (manual deploy removed in favor of auto-deploy on push)
  (db) => {
    db.exec("DROP TABLE IF EXISTS deploy_history");
    db.exec("DROP TABLE IF EXISTS deploy_configs");
  },
  // Migration 6: add upload_paths column to messages for tracking which uploads were sent
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN upload_paths TEXT");
  },
  // Migration 7: unified review surface (112) — drop the legacy per-feature
  // doc_reviews tables and replace them with a per-(session, file) schema
  // that handles both markdown section comments and code line comments.
  (db) => {
    db.exec(`
      DROP TABLE IF EXISTS review_comments;
      DROP TABLE IF EXISTS doc_reviews;

      CREATE TABLE IF NOT EXISTS file_reviews (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        doc_snapshot_hash TEXT NOT NULL DEFAULT '',
        section_headings TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_file_reviews_session_file
        ON file_reviews(session_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_file_reviews_draft
        ON file_reviews(session_id, file_path, status);

      CREATE TABLE IF NOT EXISTS file_review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER,
        section_heading TEXT,
        section_index INTEGER,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'human',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (review_id) REFERENCES file_reviews(id)
      );
      CREATE INDEX IF NOT EXISTS idx_file_review_comments_review
        ON file_review_comments(review_id);
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
      this.db.prepare("DELETE FROM secrets").run();
      this.db.prepare("DELETE FROM file_review_comments").run();
      this.db.prepare("DELETE FROM file_reviews").run();
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
