# SQLite Migration Checklist (`better-sqlite3`)

No backward compatibility with existing JSON files — clean cut.

## Phase 1: Foundation

- [x] Install `better-sqlite3` and `@types/better-sqlite3`
- [ ] Add `better-sqlite3` to both `Dockerfile.prod` and `Dockerfile.session-worker.prod` (native module — needs build tools or prebuilt binary in `node:24-slim`)
- [x] Create `src/server/shared/database.ts` — `DatabaseManager` class
  - Opens/creates `.db` file at configurable path
  - Enables WAL mode (`PRAGMA journal_mode=WAL`)
  - Enables foreign keys (`PRAGMA foreign_keys=ON`)
  - Runs schema migrations (version-based via `user_version` pragma)
  - Exposes `db` instance for use by stores
  - Closes cleanly on `close()` call
- [x] Database location: `/workspace/.shipit.db`
- [x] Add `*.db`, `*.db-wal`, `*.db-shm` to `.gitignore`

## Phase 2: Migrate ChatHistoryManager (highest value)

- [x] Create `messages` table (in migration 0, includes `in_progress` and `tool_results` columns)
- [x] Rewrite `ChatHistoryManager` to use SQLite
- [x] Constructor takes `DatabaseManager` instead of `historyDir`
- [x] Update `buildApp()` in `index.ts` to inject `DatabaseManager`
- [x] Update unit tests in `chat-history.test.ts` — use in-memory SQLite (`:memory:`)
- [x] Verify integration tests still pass

## Phase 3: Migrate UsageManager

- [x] Create `usage_turns` table (in migration 0)
- [x] Rewrite `UsageManager` to use SQLite
- [x] Constructor takes `DatabaseManager` instead of `usageFile`
- [x] Update unit tests in `usage.test.ts`
- [x] Update integration test `usage-cost-tracking.test.ts`

## Phase 4: Migrate SessionManager

- [x] Create `sessions` table (in migration 0)
- [x] Rewrite `SessionManager` — 20+ methods, all simple SQL
- [x] Constructor takes `DatabaseManager`
- [x] Update unit tests in `sessions.test.ts`
- [x] Update all integration tests that use SessionManager

## Phase 5: Migrate RepoStore

- [x] Create `repos` table (in migration 0)
- [x] Rewrite `RepoStore` to use SQLite
- [x] Constructor takes `DatabaseManager`
- [x] Update unit tests in `repo-store.test.ts`
- [x] Update integration test `repos.test.ts`

## Phase 6: Migrate DeploymentStore

- [x] Create `deploy_configs` and `deploy_history` tables (in migration 0)
- [x] Rewrite `DeploymentStore` to use SQLite
- [x] Constructor takes `DatabaseManager`
- [x] Update unit tests in `deployment-store.test.ts`
- [x] Update integration test `deployment.test.ts`

## Phase 7: Cleanup & verification

- [x] Remove old JSON file paths from all managers
- [x] Run full test suite (`npm test`) — 1869 tests pass
- [x] Run `npm run typecheck` — clean
- [x] Run `npm run lint` — clean
- [ ] Manual smoke test: create session, send messages, check usage, deploy
- [ ] Verify Docker builds succeed (native module compiles in `node:24-slim`)
