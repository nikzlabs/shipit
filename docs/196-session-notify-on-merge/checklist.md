# Checklist — notify-on-merge watch

- [x] `SessionMergeWatch` + `ChildMergedCard` domain types
- [x] `merge_watch` (sessions) + `child_merged` (messages) columns + migrations
- [x] SessionManager `setMergeWatch` / `getMergeWatch` / `listPendingMergeWatches`
- [x] `childMerged` persisted card: `PersistedMessage` field + `toRow`/`fromRow`
- [x] `MergeWatchManager` — fire / card / wake-turn / reconcile / register-time check
- [x] PR poller `onPrTerminalState` hook (merged + closed) + `merge_commit_sha`
- [x] `registerMergeWatch` service + cross-tenancy guard
- [x] Orchestrator route + worker relay + shim subcommand + help text
- [x] Wire `MergeWatchManager` in app assembly (poller hook, lookup, reconcile)
- [x] `WsChildMergedCard` type + union
- [x] Client: `ChildMergedCard`, live handler, `CARD_MESSAGE_FIELDS`, MessageList render
- [x] Agent-facing doc (`shipit-docs/sessions.md`)
- [x] Unit + poller-wire + integration tests, guard tests
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Design doc + Linear issue
