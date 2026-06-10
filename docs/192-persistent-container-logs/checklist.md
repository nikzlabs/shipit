# Checklist — Persistent container logs

## Storage
- [ ] `LogStore` (`log-store.ts`): file-backed at `sessions/{id}/logs/`; append / snapshotEntries (JSONL) / snapshotText / clear / remove + two-file rotation
- [ ] `log-store.test.ts` — round-trip (both shapes), isolation, rotation at cap, clear vs remove, torn-last-line tolerance

## Transport (unified, channel-keyed)
- [ ] `WsLogRecord` + `subscribe_logs` / `log_snapshot` / `log_append` / `log_clear` types; remove `log_entry` / `clear_logs` / `service_log*`
- [ ] Channel-keyed WS handlers in `service-handlers.ts` (shared by agent + service)

## Agent path
- [ ] `createLogBuffer` / `broadcastLog` write-through to `LogStore` (`channel: "agent"`)
- [ ] `subscribe_logs{agent}` → `log_snapshot` from `snapshotEntries` (replaces connect-time replay in `index.ts`)
- [ ] `log_clear{agent}` → `LogStore.clear`

## Service path
- [ ] `streamLogs` `handleData` appends to `LogStore`; live emit → `log_append`
- [ ] `snapshotLogs` reads `LogStore.snapshotText`; HTTP route reads store
- [ ] `docker compose logs --since` backfill on stream (re)start

## Rendering (unified)
- [ ] Add `@xterm/addon-search` dep (exact version, ≥7d; `npm install` + `check-deps`)
- [ ] `LogView.tsx` (xterm, records model, `SearchAddon` search box, `showSource` prefix); delete `ServiceLogViewer.tsx`
- [ ] `TerminalPanel` Logs tab → `<LogView channel="agent" showSource />`; **drop source-filter chips** + DOM list + `terminal-store` `LogEntry[]`/`hiddenSources`
- [ ] `PreviewServicesDrawer` → `<LogView channel={"service:"+name} />`
- [ ] Collapse log/service-log message handlers into channel-keyed path
- [ ] `LogView` test (snapshot seed, incremental append, clear, search next/prev/highlight, source prefix vs not)

## Lifecycle / cleanup
- [ ] Session archive / delete / full-reset → `LogStore.remove(sessionId)` (rm `sessions/{id}/logs`)
- [ ] Disk-janitor orphan-session `logs/` sweep

## Tests / wiring
- [ ] Extend `terminal-logs-relay.test.ts` (survives restart, cross-session non-leak, clear empties store)
- [ ] Service-manager test (chunks persisted, snapshot reads store, reconcile keeps backlog)
- [ ] No-duplicate-on-reconnect (snapshot replaces model)

## Decisions
- [ ] Open questions: keep source filtering (recommended) vs drop; hot-cache vs delete rings; retention caps; batching; fd lifecycle
- [ ] Update this checklist + `plan.md` key files as implementation lands
