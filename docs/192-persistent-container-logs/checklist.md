# Checklist — Persistent container logs

> Single PR (#1228, branch `shipit/show-all-agent-container-logs-wzo3ee`). The work below lands on one branch — "Landed" is already committed; "Remaining" extends the same PR.

## Landed — durable storage + persistence (still uses existing wire formats)

### Storage
- [x] `LogStore` (`log-store.ts`): file-backed at `sessions/{id}/logs/`; append / appendEntry / snapshotEntries (JSONL) / snapshotText / hasChannel / clear / remove + two-file rotation
- [x] `log-store.test.ts` — round-trip (both shapes), isolation, rotation at cap, clear vs remove, torn-last-line tolerance, durability across instances

### Agent path
- [x] `createLogBuffer(logStore)` / `broadcastLog` write-through to `LogStore` (`channel: "agent"`); in-memory ring kept as hot cache for diagnostics
- [x] WS-connect replay: ring when non-empty (sync, no race), else `LogStore.snapshotEntries` (post-restart durability) — `index.ts`
- [x] `clear_logs` → `clearLogBuffer` also clears `LogStore` agent channel

### Service path
- [x] `streamLogs` `handleData` appends to `LogStore`; seed-if-empty (`--tail 1000`) else follow-only (`--tail 0`) to avoid cross-restart duplication
- [x] `snapshotLogs` prefers `LogStore.snapshotText` (docker `--tail` fallback before the store is seeded); HTTP route reads it
- [x] Thread `logStore` through `runner-registry-factory` → `setupServiceManager` → `ServiceManager`

### Lifecycle / cleanup
- [x] Disk-janitor `sweepOrphanSessionLogs`: `readdir(sessionsRoot)` removing `logs/` for ids not active (keeps active+pinned, reaps archived/deleted/reset); NO `!remoteUrl` skip — mirrors `sweepOrphanCredentialDirs`

### Tests
- [x] `terminal-logs-relay.test.ts` still green (buffering, cross-session non-leak, clear)
- [x] `service-manager-snapshot.test.ts` — prefers store; falls back to docker before seed
- [x] lint:dev + typecheck + smoke green

## Remaining — transport + rendering unification + search (same PR)
- [ ] `WsLogRecord` + `subscribe_logs` / `log_snapshot` / `log_append` / `log_clear`; migrate all emit sites + client handlers atomically, then remove `log_entry` / `clear_logs` / `service_log*`
- [ ] One `appendLog(sessionId, source, text)` helper — covers category A/B/C producers, incl. the emit-only `preview-proxy.ts:308` + `rebase-driver.ts:225` deferred from PR 1
- [ ] `docker compose logs --since` backfill (closes the orchestrator-downtime gap left by `--tail 0`)
- [ ] Add `@xterm/addon-search` dep (exact version, ≥7d; `npm install` + `check-deps`)
- [ ] `LogView.tsx` (xterm, records model, `SearchAddon` search box, `showSource` prefix); delete `ServiceLogViewer.tsx`
- [ ] `TerminalPanel` Logs tab → `<LogView channel="agent" showSource />`; **drop source-filter chips** + DOM list + `terminal-store` `LogEntry[]`/`hiddenSources`
- [ ] `PreviewServicesDrawer` → `<LogView channel={"service:"+name} />`
- [ ] `LogView` test (snapshot seed, incremental append, clear, search next/prev/highlight, source prefix vs not)

## Decisions
- [x] Storage → per-session files, not SQLite (avoid contending with chat-history/usage on `.shipit.db`)
- [x] Source filtering → drop the cryptic chips, add search instead (PR 2)
- [x] Hot-cache vs delete rings → keep the in-memory rings as a hot cache (diagnostics reads them synchronously)
- [ ] Retention caps (currently ~1 MB/channel, 2-file rotation), append batching, `--since` follower — revisit in PR 2 / with real-volume data
