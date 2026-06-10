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

## Landed — transport + rendering unification + search (same PR)

### Transport
- [x] `WsLogRecord` + `LogSource` + `LogRingEntry` in `terminal-types.ts`; `subscribe_logs` / `log_clear` (c→s), `log_snapshot` / `log_append` (s→c); removed `log_entry` / `clear_logs` / `service_log` / `service_log_buffer` / `subscribe_service_logs`
- [x] `log-emit.ts` — `agentLogAppend(source, text)` builder + `appendAgentLog(...)` helper; migrated every agent emit site (sessionBroadcastLog, auto-push, stack-error, container-exit, preview-error, rebase force-push)
- [x] Connect-time replay → one `log_snapshot { channel: "agent" }` (RESETS the client model — no reconnect dup, old `clear_logs` dance gone); turn-buffer replay skips `log_append`
- [x] `handleSubscribeLogs` / `handleLogClear` (channel-keyed, agent + `service:<name>`); service live emit → `log_append`; `snapshotLogs` still store-first

### Rendering + search
- [x] `@xterm/addon-search@0.16.0` (exact, ≥7d, `check-deps` green)
- [x] `LogView.tsx` — one xterm renderer (records model, epoch-driven incremental write vs full rewrite, `SearchAddon` box w/ next/prev/count + ⌘/Ctrl-F, `showSource` prefix); `ServiceLogViewer.tsx` deleted
- [x] `TerminalPanel` → `<LogView channel="agent" showSource />`; **source-filter chips + DOM list gone**; `terminal-store` reduced to `mode`/`shellStarted`
- [x] `PreviewServicesDrawer` → `<LogView channel={"service:"+name} />`; "Send to Agent" reads the `log-store`
- [x] Client `log-store.ts` (channel-keyed, bounded, epoch) fed by `log_snapshot`/`log_append` dispatcher handlers; reset on session switch; `install_log` routes into the agent channel

### Tests
- [x] `LogView.test.tsx` (snapshot/append/clear, source prefix vs raw, subscribe-on-mount, search next/prev) + client `log-store.test.ts`
- [x] `terminal-logs-relay.test.ts` rewritten to the channel-keyed protocol; stack-error / preview-error / container-exit / auto-push / rebase-driver / diagnostics / TerminalPanel / PreviewServicesDrawer tests updated; full lint + typecheck + `test:dev` green

## Decisions
- [x] Storage → per-session files, not SQLite (avoid contending with chat-history/usage on `.shipit.db`)
- [x] Source filtering → dropped the cryptic chips, replaced with search (`SearchAddon`)
- [x] Hot-cache vs delete rings → keep the in-memory rings as a hot cache (diagnostics reads them synchronously)
- [x] Client transport → route logs through a zustand `log-store` (dispatcher-fed), not the raw WS drain (`useMessageHandler` drains the whole queue every render, so a `drainMessages` consumer races it — the old `ServiceLogViewer` pattern; the store makes delivery lossless)
- [x] Bucket-C producers (preview-proxy, rebase force-push) → emit-only via `log_append` (no `broadcastLog` in scope; same as before — those lines were never persisted nor reconnect-replayed, so zero behavior change beyond the unified envelope)

## Deferred (follow-ups, not blocking)
- [ ] `docker compose logs --since` backfill for the **service** channel — `--tail 0` after a seeded restart still skips lines Docker retained while the orchestrator was down. Agent logs are fully persisted; service history is bounded by container lifetime as before. Documented in `streamLogs`.
- [ ] Server-side full-backlog grep (search currently covers the loaded snapshot tail, which is the bounded retained history)
- [ ] Append batching / retention-cap tuning — revisit with real-volume data
