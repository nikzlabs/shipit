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
  // Migration 8: add per-turn cache tokens and model to usage_turns and a
  // serialized turn-usage blob to messages for the context-dial UI (105).
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_read_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN cache_create_tokens INTEGER");
    db.exec("ALTER TABLE usage_turns ADD COLUMN model TEXT");
    db.exec("ALTER TABLE messages ADD COLUMN turn_usage TEXT");
  },
  // Migration 9: persisted PR status snapshot per session so archived sessions
  // retain their PR badge / link / state across server restarts. Stored as a
  // JSON blob of PrStatusSummary; written by the poller on each update.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN pr_status TEXT");
  },
  // Migration 10: subagent events column for Task-tool transparency (109).
  // Stores a JSON-serialized array of SubagentEvent entries (assistant +
  // tool_result events from spawned subagents) so reloading chat history
  // shows the same nested tree as live streaming.
  (db) => {
    db.exec("ALTER TABLE messages ADD COLUMN subagent_events TEXT");
  },
  // Migration 11: parent linkage for agent-spawned sessions (117). When a
  // session is created via the `shipit session create` shim, its row carries
  // the parent's session id (used to render sidebar grouping and to scope
  // the agent-facing `shipit session view/message/archive` operations to
  // children the parent itself spawned). `spawned_by_turn` is a free-form
  // string identifying the spawning turn — used for "this turn first"
  // sorting in `shipit session list`.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN spawned_by_turn TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
  },
  // Migration 12: real per-turn context occupancy. Adds `context_tokens` to
  // `usage_turns` — populated from the last entry in `result.usage.iterations[]`
  // so the context dial doesn't over-count by N× for tool-heavy turns
  // (top-level `usage.cache_read_input_tokens` is the SUM across all API
  // calls). Old rows leave the column NULL and the dial falls back to the
  // sum (`turnContextTokens()`).
  (db) => {
    db.exec("ALTER TABLE usage_turns ADD COLUMN context_tokens INTEGER");
  },
  // Migration 13: per-session agent (provider) so the user's model/agent
  // picks in one session don't bleed into others via the global
  // `vibe-agent-id` / `vibe-model-id` localStorage keys. The WS handler
  // locks these in on first connect; after that, only `session.agent_id`
  // and `session.model` matter.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
  },
  // Migration 14: per-agent credential isolation (docs/138). `agent_pinned`
  // records that a session has taken its first turn — at that point the agent
  // is fixed for the session's life and its credentials have been provisioned
  // into the per-session credentials directory. The server rejects `set_agent`
  // once this is set, and the credential provisioning step is skipped (it's
  // write-once). Defaults to 0 (not yet pinned).
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_pinned INTEGER DEFAULT 0");
  },
  // Migration 15: user-controllable repo ordering in the sidebar. `display_order`
  // is NULL for repos that have never been reordered — those still sort by
  // `last_used_at DESC` (existing behavior). Once the user drags a repo, every
  // repo gets a non-NULL integer so the chosen order is fully determined.
  (db) => {
    db.exec("ALTER TABLE repos ADD COLUMN display_order INTEGER");
  },
  // Migration 16: markdown review comments anchor to user text selections, not
  // to `## ` headings. Adds quoted_text/context_before/context_after columns,
  // and migrates existing `kind='section'` rows by promoting the heading text
  // (sans `## ` prefix) into quoted_text. The legacy section_heading and
  // section_index columns are left in place to avoid a destructive rewrite of
  // sent-review history; they're no longer read by the application code.
  (db) => {
    db.exec(`
      ALTER TABLE file_review_comments ADD COLUMN quoted_text TEXT;
      ALTER TABLE file_review_comments ADD COLUMN context_before TEXT;
      ALTER TABLE file_review_comments ADD COLUMN context_after TEXT;

      UPDATE file_review_comments
         SET quoted_text = TRIM(REPLACE(COALESCE(section_heading, ''), '## ', '')),
             context_before = '',
             context_after = '',
             kind = 'selection'
       WHERE kind = 'section';
    `);
  },
  // Migration 17: durable rewind/fork metadata (docs/144 Landing 1).
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN rolled_back INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN notice_level TEXT;
      ALTER TABLE messages ADD COLUMN fork_child TEXT;
      ALTER TABLE messages ADD COLUMN code_rollback_hash TEXT;
    `);
  },
  // Migration 18: provider-account routing (docs/150). Sessions persist both
  // the route kind and route id so account rows are never confused with
  // reserved env/API-key auth routes.
  (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_kind TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN provider_route_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_provider_route ON sessions(provider_route_kind, provider_route_id)");
  },
  // Migration 19: rewind undo snapshots (docs/144 Landing 2). Rows are small,
  // short-lived restore records used by the undo toast and topbar recovery
  // entry. Expiry is enforced lazily by the ChatHistoryManager helpers.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rewind_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rewind_snapshots_session_expires
        ON rewind_snapshots(session_id, expires_at_ms);
    `);
  },
  // Migration 20: marketplaces table (docs/149 — skill install UX). Holds the
  // catalog list shown in Settings → Skills → Discover, keyed by short id
  // (e.g. `claude-plugins-official`). v1 seeds one row at startup and never
  // inserts/deletes after that; v2 adds the add/remove verbs. `source` is a
  // JSON-encoded `MarketplaceSource`. `agent_id` filters the Discover list to
  // the active session's agent. `status` reflects the most recent fetch
  // attempt (loading / ok / fetch-failed) so the UI can render a retry button.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS marketplaces (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        auto_update INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'loading',
        last_fetched_at TEXT,
        fetch_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_marketplaces_agent ON marketplaces(agent_id);
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
      this.db.prepare("DELETE FROM rewind_snapshots").run();
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
