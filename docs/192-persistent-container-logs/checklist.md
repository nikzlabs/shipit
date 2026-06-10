# Checklist — Persistent container logs

- [ ] `container_logs` migration (table + index) in `database.ts`
- [ ] `LogStore` (`log-store.ts`): append / snapshotEntries / snapshotText / clear / remove + append-time prune
- [ ] `log-store.test.ts` — round-trip, isolation, prune (entries + bytes), clear vs remove, monotonic seq
- [ ] Agent path: `createLogBuffer` / `broadcastLog` write-through to `LogStore`
- [ ] Agent path: WS-connect replay reads `LogStore.snapshotEntries` (`index.ts`)
- [ ] Agent path: `clear_logs` → `LogStore.clear(session, "agent")`
- [ ] Service path: `streamLogs` `handleData` appends to `LogStore`
- [ ] Service path: `snapshotLogs` reads `LogStore.snapshotText` as source of truth
- [ ] Service path: `docker compose logs --since` backfill on stream (re)start
- [ ] Session archive / delete / full-reset → `LogStore.remove(sessionId)`
- [ ] Disk-janitor orphan-session log sweep
- [ ] Extend `terminal-logs-relay.test.ts` (survives restart, cross-session non-leak, clear empties store)
- [ ] Service-manager test (chunks persisted, snapshot reads store, reconcile keeps backlog)
- [ ] No-duplicate-on-reconnect client idempotency check
- [ ] Decide open questions (hot-cache vs delete rings; retention caps; batching)
- [ ] Update this checklist + `plan.md` key files as implementation lands
