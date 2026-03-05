---
status: planned
---

# SQLite vs Plain Files Investigation

## Current State: File-Based Persistence

ShipIt uses **12 file-based persistence points**, all JSON (except git config and system prompt). None use atomic writes, file locking, or fsync.

### Inventory

| Store | Location | Size | Write Freq | Concern Level |
|-------|----------|------|------------|---------------|
| Sessions | `.vibe-sessions.json` | ~1-2 KB | Low | Low |
| Repos | `.vibe-repos.json` | ~1 KB | Low | Low |
| **Chat History** | `.vibe-chat-history/{id}.json` | **10-200 KB** | **High** | **High** |
| **Usage/Cost** | `.shipit-usage.json` | **10-100 KB** | **High** | **Medium** |
| Credentials | `/credentials/shipit-credentials.json` | <2 KB | Low | Low |
| Deploy Configs | `.shipit-deploy/configs/` | 1-5 KB | Low | Low |
| Deploy History | `.shipit-deploy/history/` | 5-20 KB | Low | Low |
| Git Config | `/credentials/.gitconfig` | ~100 B | Very low | Low |
| System Prompt | `.shipit/system-prompt.md` | <50 KB | Very low | Low |
| Claude CLI Config | `/root/.claude.json` | ~200 B | Very low | Low |

### Current Problems

1. **Non-atomic writes everywhere** — Every store does `readFileSync` → modify → `writeFileSync`. A crash mid-write corrupts the file. No temp-file-rename pattern is used.
2. **No concurrency control** — Chat history is especially vulnerable. Multiple processes could write the same session file simultaneously.
3. **Full-file rewrites** — Appending one chat message requires reading and rewriting the entire history file. Same for usage records.
4. **No querying** — To find usage for a specific session, the entire usage file must be loaded and filtered in memory.
5. **File proliferation** — Chat history creates one file per session. Over time this means hundreds of small files.
6. **Silent data loss** — Corrupted files return empty arrays/objects. No detection, no recovery.

## SQLite Option Analysis

### Library Options

| Library | API | Maturity | Dependency |
|---------|-----|----------|------------|
| `node:sqlite` | Sync (`DatabaseSync`) | Release candidate (Node 25.x) | None (built-in) |
| `better-sqlite3` | Sync | Stable, battle-tested | Native module (prebuilt binaries) |

`better-sqlite3` is the pragmatic choice today — stable, fastest, well-documented. `node:sqlite` is converging on the same API but is not yet fully stable. ShipIt runs in Docker where native module compilation is controlled, so the dependency cost is low.

### What SQLite Solves

| Problem | JSON Files | SQLite |
|---------|-----------|--------|
| Atomic writes | No (manual temp+rename needed) | Yes (ACID transactions) |
| Concurrent access | No locking | WAL mode handles it |
| Partial updates | Rewrite entire file | Update single row |
| Querying/filtering | Load all → filter in memory | SQL indexes |
| Crash recovery | Corruption → empty default | WAL journal recovery |
| Storage efficiency | ~1x | ~0.3-0.5x (no repeated keys, no pretty-print) |

### What SQLite Doesn't Solve

- **Human readability** — JSON files can be inspected with a text editor. SQLite requires tooling.
- **Simplicity for small configs** — A 200-byte credentials file doesn't benefit from a database.
- **Docker volume concerns** — SQLite needs its DB file on a persistent volume, same as JSON files.

## Recommendation: Hybrid Approach

### Move to SQLite (high value)

These stores have the most to gain — they're written frequently, grow over time, and benefit from querying:

1. **Chat History** — Highest priority. Per-message writes cause full-file rewrites of the largest files. SQLite enables appending rows, querying by session, and pagination. Schema:
   ```sql
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,  -- JSON blob
     git_hash TEXT,
     parent_hash TEXT,
     created_at TEXT DEFAULT (datetime('now')),
     FOREIGN KEY (session_id) REFERENCES sessions(id)
   );
   CREATE INDEX idx_messages_session ON messages(session_id);
   ```

2. **Usage/Cost Tracking** — Append-heavy, benefits from aggregation queries (total cost per session, cost over time). Schema:
   ```sql
   CREATE TABLE usage_turns (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     cost_usd REAL NOT NULL,
     duration_ms INTEGER,
     input_tokens INTEGER,
     output_tokens INTEGER,
     created_at TEXT DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_usage_session ON usage_turns(session_id);
   ```

3. **Sessions + Repos** — Modest benefit, but natural to include since they're queried together. Enables filtering archived/warm sessions without loading all.

4. **Deployment History** — Append-heavy per session. Querying across sessions becomes possible.

### Keep as Files (low value from migration)

- **Credentials** (`shipit-credentials.json`) — Small, rarely written, benefits from file permissions (`0o600`), and lives on a separate volume.
- **System Prompt** (`.shipit/system-prompt.md`) — Plain text, human-editable by design.
- **Git Config** (`.gitconfig`) — Uses git CLI, not our concern.
- **Claude CLI Config** (`/root/.claude.json`) — Owned by Claude CLI.

## Migration Path

### Phase 1: Add SQLite alongside files
- Add `better-sqlite3` dependency
- Create a `StorageManager` that initializes the DB with schema + migrations
- Migrate `ChatHistoryManager` and `UsageManager` to SQLite
- Keep JSON read fallback for existing data (one-time migration on first load)

### Phase 2: Migrate remaining stores
- Move `SessionManager` and `RepoStore` to SQLite tables
- Move `DeploymentStore` to SQLite
- Remove JSON file code paths after migration

### Phase 3: Leverage SQLite capabilities
- Add full-text search over chat history
- Add usage analytics queries (cost trends, token usage over time)
- Add proper pagination for long chat histories
- Consider using SQLite's JSON functions for flexible metadata

## Estimated Impact

| Metric | Before | After |
|--------|--------|-------|
| Data safety | No crash protection | ACID transactions |
| Chat append latency | O(n) — rewrite full file | O(1) — insert row |
| Usage query | Load all → filter | Indexed SQL query |
| File count | ~N+10 files (N = sessions) | 1 DB file + config files |
| Dependency cost | None | +1 native module (~3 MB) |
| Code complexity | Simple fs calls | SQL + migration logic |

## Open Questions

1. **Database location** — Should the SQLite DB live at `/workspace/.shipit.db` or on the `/credentials` volume? Workspace is reset more often but is where session data naturally lives.
2. **node:sqlite timeline** — Should we wait for `node:sqlite` to reach stable instead of adding `better-sqlite3`? Risk: unknown timeline.
3. **Backup strategy** — SQLite's `.backup()` API could enable periodic snapshots. Worth implementing?
4. **Sync vs async** — `better-sqlite3` is synchronous (like current `readFileSync`/`writeFileSync` calls), so the migration is straightforward. But should we consider async for future scalability?
