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
- [x] planning#256 — a `systemTurn` dispatch is never live-steered into a running turn
- [x] planning#257 — the interactive queue drain no longer narrows a queued entry
      (`QueuedMessage.execution` tag + the shared `startQueuedMessage` router)
- [x] planning#260 — a failed wake-turn delivery is retried in-process (retry
      supervisor + `inFlight` in-flight discrimination + persisted
      `deliveryAttempts`/`lastAttemptAt` backoff), capped at a terminal
      `delivery-failed` with a persisted failure card; stale "next poll retries"
      comments corrected
- [x] Arming again (requirements.md reqs 2–4): `reportedPr` handed from watch to
      watch, `rearmedAt` + the watch that follows a delivery, a `watchId` on every
      watch, the `previousMergedPr` fallback, and the CLI text for each case
- [x] docs/328-session-message-inbox req 6 — a parent's notice goes to its inbox and
      ends the watch in the same transaction; the wake turn, its retry supervisor and
      `delivery-failed` serve the `--self` watch only; a watch that an older ShipIt
      left in delivery is not told a second time
