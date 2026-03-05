# SQLite Migration Checklist (`better-sqlite3`)

No backward compatibility with existing JSON files — clean cut.

## Phase 1: Foundation

- [ ] Install `better-sqlite3` and `@types/better-sqlite3`
- [ ] Add `better-sqlite3` to both `Dockerfile.prod` and `Dockerfile.session-worker.prod` (native module — needs build tools or prebuilt binary in `node:24-slim`)
- [ ] Create `src/server/shared/database.ts` — `DatabaseManager` class
  - Opens/creates `.db` file at configurable path
  - Enables WAL mode (`PRAGMA journal_mode=WAL`)
  - Enables foreign keys (`PRAGMA foreign_keys=ON`)
  - Runs schema migrations (version table + sequential migration functions)
  - Exposes `db` instance for use by stores
  - Closes cleanly on process exit
- [ ] Decide database location: `/workspace/.shipit.db` (resets with workspace) vs `/credentials/shipit.db` (persists)
- [ ] Add `*.db`, `*.db-wal`, `*.db-shm` to `.gitignore`

## Phase 2: Migrate ChatHistoryManager (highest value)

**Current:** `src/server/orchestrator/chat-history.ts` — one JSON file per session in `.vibe-chat-history/`

- [ ] Create `messages` table:
  ```sql
  CREATE TABLE messages (
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
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_session ON messages(session_id);
  ```
- [ ] Rewrite `ChatHistoryManager` to use SQLite
  - `append()` → `INSERT INTO messages`
  - `load()` → `SELECT ... WHERE session_id = ? ORDER BY id`
  - `updateLastMessage()` → `UPDATE messages SET ... WHERE id = (SELECT MAX(id) FROM messages WHERE session_id = ?)`
  - `truncate()` → `DELETE FROM messages WHERE session_id = ? AND id > ?` (keep first N)
  - `saveMessages()` → transaction: delete all for session, insert all
  - `delete()` → `DELETE FROM messages WHERE session_id = ?`
  - `listSessions()` → `SELECT DISTINCT session_id FROM messages`
- [ ] Constructor takes `DatabaseManager` instead of `historyDir`
- [ ] Update `buildApp()` in `index.ts` to inject `DatabaseManager`
- [ ] Update unit tests in `chat-history.test.ts` — use in-memory SQLite (`:memory:`)
- [ ] Verify integration tests still pass

## Phase 3: Migrate UsageManager

**Current:** `src/server/orchestrator/usage.ts` — single `.shipit-usage.json` file

- [ ] Create `usage_turns` table:
  ```sql
  CREATE TABLE usage_turns (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    duration_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_usage_session ON usage_turns(session_id);
  ```
- [ ] Rewrite `UsageManager` to use SQLite
  - `record()` → `INSERT INTO usage_turns`
  - `getSessionUsage()` → `SELECT SUM(cost_usd), SUM(duration_ms), COUNT(*) FROM usage_turns WHERE session_id = ?`
  - `getSessionTokenTotals()` → `SELECT SUM(input_tokens), SUM(output_tokens) FROM usage_turns WHERE session_id = ?`
  - `getSessionTurns()` → `SELECT * FROM usage_turns WHERE session_id = ? ORDER BY id`
  - `getStats()` → `SELECT session_id, SUM(cost_usd), ... GROUP BY session_id` + aggregate total
  - `delete()` → `DELETE FROM usage_turns WHERE session_id = ?`
  - `clear()` → `DELETE FROM usage_turns`
- [ ] Constructor takes `DatabaseManager` instead of `usageFile`
- [ ] Update unit tests in `usage.test.ts`
- [ ] Update integration test `usage-cost-tracking.test.ts`

## Phase 4: Migrate SessionManager

**Current:** `src/server/orchestrator/sessions.ts` — single `.vibe-sessions.json` file

- [ ] Create `sessions` table:
  ```sql
  CREATE TABLE sessions (
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
  CREATE INDEX idx_sessions_remote ON sessions(remote_url);
  CREATE INDEX idx_sessions_warm ON sessions(warm) WHERE warm = 1;
  ```
- [ ] Rewrite `SessionManager` — 20+ methods, all become simple SQL
  - `list()` → `SELECT * FROM sessions WHERE archived = 0 AND warm = 0 ORDER BY last_used_at DESC`
  - `track()` → `INSERT OR REPLACE` (upsert)
  - `get()` → `SELECT * WHERE id = ?`
  - Setter methods → single-column `UPDATE` statements
  - `archive()`/`unarchive()` → `UPDATE sessions SET archived = ? WHERE id = ?`
  - `findUngraduatedWarm()` → `SELECT * WHERE warm = 1 AND remote_url = ? AND id != ?`
  - `findAllByRemoteUrl()` → `SELECT * WHERE remote_url = ?`
- [ ] Constructor takes `DatabaseManager`
- [ ] Update unit tests in `sessions.test.ts`
- [ ] Update all integration tests that use SessionManager

## Phase 5: Migrate RepoStore

**Current:** `src/server/orchestrator/repo-store.ts` — single `.vibe-repos.json` file

- [ ] Create `repos` table:
  ```sql
  CREATE TABLE repos (
    url TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'cloning',
    warm_session_id TEXT
  );
  ```
- [ ] Rewrite `RepoStore` to use SQLite
  - `add()` → `INSERT OR IGNORE` + `SELECT`
  - `list()` → `SELECT * ORDER BY last_used_at DESC`
  - `touch()` → `UPDATE repos SET last_used_at = ? WHERE url = ?`
  - `remove()` → `DELETE FROM repos WHERE url = ?`
- [ ] Constructor takes `DatabaseManager`
- [ ] Update unit tests in `repo-store.test.ts`
- [ ] Update integration test `repos.test.ts`

## Phase 6: Migrate DeploymentStore

**Current:** `src/server/orchestrator/deployment-store.ts` — directory tree under `.shipit-deploy/`

- [ ] Create tables:
  ```sql
  CREATE TABLE deploy_configs (
    session_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    credentials TEXT NOT NULL,  -- JSON blob
    project_name TEXT,
    PRIMARY KEY (session_id, target_id)
  );

  CREATE TABLE deploy_history (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    url TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  CREATE INDEX idx_deploy_history_session ON deploy_history(session_id);
  ```
- [ ] Rewrite `DeploymentStore` to use SQLite
  - `saveConfig()` → `INSERT OR REPLACE INTO deploy_configs`
  - `loadConfig()` → `SELECT * WHERE session_id = ? AND target_id = ?`
  - `listConfiguredTargets()` → `SELECT target_id FROM deploy_configs WHERE session_id = ?`
  - `recordDeployment()` → `INSERT INTO deploy_history`
  - `getHistory()` → `SELECT * FROM deploy_history WHERE session_id = ? ORDER BY timestamp DESC`
  - `deleteSession()` → transaction: delete from both tables where session_id = ?
- [ ] Constructor takes `DatabaseManager`
- [ ] Update unit tests in `deployment-store.test.ts`
- [ ] Update integration test `deployment.test.ts`

## Phase 7: Cleanup & verification

- [ ] Remove old JSON file paths from all managers
- [ ] Remove `.vibe-sessions.json`, `.vibe-repos.json`, `.shipit-usage.json`, `.vibe-chat-history/`, `.shipit-deploy/` references from codebase
- [ ] Run full test suite (`npm test`)
- [ ] Run `npm run typecheck`
- [ ] Run `npm run lint`
- [ ] Manual smoke test: create session, send messages, check usage, deploy
- [ ] Verify Docker builds succeed (native module compiles in `node:24-slim`)
