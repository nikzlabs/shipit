# Self-merge wake — checklist

## Watch state

- [ ] `self_merge_watch` column + migration (`database.ts`)
- [ ] `SessionInfo.selfMergeWatch`; `followUp` + `expired` / `cancelled` states on the watch type
- [ ] `setSelfMergeWatch` / `getSelfMergeWatch` in `sessions.ts`
- [ ] `listPendingMergeWatches` also returns pending self-watches

## Arm surface

- [ ] `--self` + `--then` on the `notify-on-merge` subcommand (`agent-shim/shipit-session.ts`)
- [ ] Worker relay (`agent-ops-routes.ts`)
- [ ] `POST /api/sessions/:id/self-merge-watch` — arms, refuses an archived session, fires `checkAndFireNow`

## Delivery

- [ ] `handleSelfMerge` in `merge-watch.ts` (reuses the docs/196 machine)
- [ ] Call it from `onMergeDetectedCb` **after** `markMergedAndPruneExcess`, beside `emitResetEligibleSignal`
- [ ] Call `autoResetMergedBranchOnContinue` before `dispatch`; failed gate still dispatches
- [ ] `self` branch in `buildWakeTurnPrompt` (shared escape clause)
- [ ] `delivered` stamped only from `onTurnComplete`
- [ ] Closed-without-merge → `expired`, no dispatch
- [ ] Woken turn must not arm another self-watch
- [ ] `reconcilePending` covers self-watches
- [ ] Pending self-watch keeps `PollingGlobalGate` open

## Arm card

- [ ] `selfMergeWatch` `PersistedMessage` field + `self_merge_watch_card` column + migration
- [ ] `toRow` / `fromRow` + rehydrate in `loadSessionHistory`
- [ ] `upsertSelfMergeWatchCard` (the `upsertReleaseCard` pattern)
- [ ] Register in `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] WS type in `TRANSCRIPT_SCOPED_MESSAGES`
- [ ] Client card component + message handler
- [ ] `cancel_self_merge_watch` WS handler → clear watch + patch card

## Tests

- [ ] `merge-watch.test.ts` — fire-once, delivered-means-ran, busy drain, expired, cancelled, archived, reconcile
- [ ] Delivery — reset before dispatch; failed gate still dispatches; wake throw leaves `merge-observed`
- [ ] Ordering regression — `mergedAt` + `mergedHeadSha` set when the self-watch fires
- [ ] `polling-global-gate.test.ts` — pending self-watch keeps the gate open
- [ ] Integration — arm → merge → reset + one turn + new PR; no chained watch
- [ ] `chat-history.test.ts` / `visual-elements.test.ts` — card guard contract

## Docs

- [ ] `src/server/shipit-docs/sessions.md` — `--self --then`, one-turn-one-PR
- [ ] Update `docs/196-session-notify-on-merge/plan.md` to cross-reference the self variant
