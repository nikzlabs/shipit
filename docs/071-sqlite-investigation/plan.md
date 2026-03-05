---
status: planned
---

# Storage Investigation: SQLite vs PostgreSQL vs Plain Files (+ Bun vs Node)

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

## PostgreSQL vs SQLite

ShipIt runs on **Node 24** (`node:24-slim`) as an orchestrator + session worker containers in Docker. This section evaluates whether PostgreSQL is a better fit than SQLite.

### Architecture Fit

| Dimension | SQLite | PostgreSQL |
|-----------|--------|------------|
| Deployment | In-process library, zero config | Separate Docker container, connection strings, health checks |
| Network | Direct filesystem access | TCP round-trip per query |
| Startup | Instant | 2-5 seconds |
| Idle RAM | ~0 MB | 50-200+ MB |
| Disk | Single `.db` file | ~150 MB Docker image + data dir |
| Backup | Copy one file | `pg_dump` or streaming replication |
| Docker Compose | No extra service | New `postgres` service with env vars, `shm_size`, `depends_on` |

**SQLite is the natural fit.** ShipIt is a single-user app. PostgreSQL solves multi-user concurrency problems ShipIt doesn't have, while adding a network hop, a daemon process, and deployment complexity.

### Concurrency Across Containers

The most nuanced dimension. SQLite allows one writer at a time, and sharing a SQLite file across Docker containers via volume mounts is unreliable on some platforms.

**This aligns with ShipIt's existing architecture:** The orchestrator owns global state (sessions, repos, credentials). Each session container owns its own state (chat history, usage). The highest-write stores are session-scoped and single-process — perfect for SQLite. For cross-layer reads, the orchestrator already proxies through the session worker's HTTP API (`session-worker.ts`).

PostgreSQL's advantage (any container connects over Docker network) only matters if orchestrator and session workers must share writable state in a single store, which the current design avoids.

### PostgreSQL Feature Advantages

| Feature | PostgreSQL | SQLite Equivalent |
|---------|-----------|-------------------|
| LISTEN/NOTIFY | Built-in pub/sub | No equivalent (use WebSocket) |
| JSONB | Binary JSON + GIN indexes | json1 extension, no binary format |
| Full-text search | tsvector/tsquery with stemming | FTS5 extension, less mature |
| pgvector | Vector similarity for embeddings | No equivalent |
| Parallel queries | Multi-core execution | Single-threaded |

**None of these are required for ShipIt's current or near-term needs.** SQLite's FTS5 and JSON functions are sufficient. pgvector would only matter if semantic search over chat history becomes a goal — and by then, a dedicated vector store would be more appropriate.

### When to Reconsider PostgreSQL

- ShipIt becomes a **multi-tenant cloud service** (multiple users, shared state)
- Need for **LISTEN/NOTIFY** pub/sub (real-time cross-service events)
- Need for **pgvector** semantic search across all users
- Data volume grows to **multiple GB** with complex relational queries

### Verdict: SQLite

PostgreSQL is overkill for ShipIt's single-user, container-per-session architecture. It adds operational complexity (separate container, connection management, health checks) to solve problems ShipIt doesn't have. SQLite gives ACID transactions, indexed queries, and crash recovery with zero infrastructure.

---

## Bun vs Node: Impact on Storage Decision

ShipIt currently runs on **Node 24** (`node:24-slim`). Does switching to Bun change the storage calculus?

### Bun's Storage Advantages

| Capability | Bun | Node 24 |
|------------|-----|---------|
| Built-in SQLite | `bun:sqlite` — zero deps, ships with runtime | `node:sqlite` — release candidate, not yet stable |
| File I/O speed | ~3x faster raw reads/writes | Baseline |
| Built-in Postgres | `Bun.sql` (since 1.2) | `pg` or `postgres.js` library |
| Native module support | Limited — `better-sqlite3` does **not** work | Full support |

### Key Finding: Bun's File I/O Speed Doesn't Change the Decision

Bun's ~3x faster file I/O sounds appealing for the current JSON file approach, but it doesn't address the **structural problems**: no concurrent writes, no partial updates, no querying, no atomicity. Making a broken pattern faster doesn't fix it.

### Key Risk: Fastify + WebSocket Compatibility

ShipIt's biggest Bun risk has nothing to do with storage:

- **Fastify is not officially supported on Bun.** Known WebSocket regressions exist (`@fastify/websocket` bugs as recently as May 2025).
- **`better-sqlite3` does not work on Bun** due to Node.js ABI version mismatches (open issue as of April 2025). `bun:sqlite` is the only option.
- ShipIt relies heavily on Fastify + WebSockets + child process spawning + PTY terminals — all areas where Bun's remaining ~4% Node.js incompatibilities are concentrated.
- No LTS policy. Fastify team won't debug Bun-specific issues.

### Bun's `bun:sqlite` vs Node's Options

| Library | Runtime | Performance | Maturity | Dependency |
|---------|---------|-------------|----------|------------|
| `bun:sqlite` | Bun only | Fast (disputed 3-6x claims) | Stable within Bun | None |
| `better-sqlite3` | Node only | Best in class | Battle-tested | Native module |
| `node:sqlite` | Node 22+ | Good | Release candidate | None |

The claimed 3-6x speed advantage of `bun:sqlite` over `better-sqlite3` mainly reflects JavaScriptCore's object conversion speed, not SQLite execution. For real-world queries, `better-sqlite3` can match or beat it.

### Verdict: Stay on Node

**The runtime decision is independent of the storage decision.** Bun's `bun:sqlite` is nice but doesn't justify the Fastify/WebSocket compatibility risks. Make the storage decision (SQLite over files) on Node 24, using `better-sqlite3`. Revisit Bun in 6-12 months as server-side compatibility matures.

If ShipIt does migrate to Bun later, switching from `better-sqlite3` to `bun:sqlite` is a small, mechanical change — the APIs are nearly identical.

### Storage Format Compatibility

Both `better-sqlite3` and `bun:sqlite` wrap the standard SQLite3 C library. **The database file format is identical** — a `.db` file created by one opens in the other with zero conversion.

| Layer | Compatible? | Notes |
|-------|-------------|-------|
| Database file | Identical | Standard SQLite3 format, byte-for-byte |
| JavaScript API | Similar, not drop-in | `bun:sqlite` inspired by `better-sqlite3`, minor differences |
| Adapter cost | ~100 lines | Community [bun-better-sqlite3](https://github.com/nounder/bun-better-sqlite3) shim exists |

A future Node→Bun migration would mean: swap the import, adjust a few API calls (or use the shim), keep the same database files. No data migration needed. This confirms that choosing `better-sqlite3` today does not create lock-in.

---

## Final Recommendation

```
                    ┌─────────────────────────┐
                    │     Decision Matrix      │
                    ├─────────────────────────┤
                    │ Runtime: Node 24    ✅   │
                    │ Database: SQLite    ✅   │
                    │ Library: better-sqlite3  │
                    │ PostgreSQL: Not now  ⏳   │
                    │ Bun: Not now        ⏳   │
                    └─────────────────────────┘
```

**Use SQLite via `better-sqlite3` on Node 24.** This gives:
- ACID transactions replacing non-atomic file writes
- O(1) appends replacing O(n) full-file rewrites
- Indexed queries replacing load-all-and-filter
- Zero infrastructure (no Postgres container)
- Straightforward migration from current sync file I/O (both are synchronous)
- Easy future path to `bun:sqlite` or `node:sqlite` if runtime changes

## Open Questions

1. **Database location** — Should the SQLite DB live at `/workspace/.shipit.db` or on the `/credentials` volume? Workspace is reset more often but is where session data naturally lives.
2. **node:sqlite timeline** — Should we wait for `node:sqlite` to reach stable instead of adding `better-sqlite3`? Risk: unknown timeline. On Node 24, it's release candidate.
3. **Backup strategy** — SQLite's `.backup()` API could enable periodic snapshots. Worth implementing?
4. **Schema migration tooling** — Use a library (e.g., `better-sqlite3-migrations`) or hand-roll version-based migrations?
5. **Orchestrator vs session DB** — One shared DB, or separate DBs per layer matching the container architecture?
