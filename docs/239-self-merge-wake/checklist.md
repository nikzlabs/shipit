# Self-merge wake — checklist

## Prerequisites (bugs in shipped code — fix before building on them)

- [x] **P1** `trySteerDispatch` returns false for `systemTurn` / callback-carrying dispatches — SHI-254
- [x] **P2** interactive queue drain preserves `systemTurn` + `onTurnComplete` — SHI-255
- [x] **P3** retry path for a failed delivery that doesn't require an orchestrator restart — SHI-258
- [ ] **P4** turn adoption drain re-narrows queued entries — SHI-259
- [ ] **P5** `onTurnComplete` never fires on a no-result retry — SHI-260

## Watch state

- [ ] Distinct `SelfMergeWatch` type (watchId, generation, `followUp`, full state set)
- [ ] `self_merge_watch` column + migration
- [ ] CAS transitions in `sessions.ts` (`armed → merge-observed` vs `armed → cancelled`)
- [ ] `listPendingSelfMergeWatches` (separate from the child list)
- [ ] Own delivery lease keyed on `watchId + attemptId` (SHI-258's `inFlight` is not one)
- [ ] Shared exhaustive `isPending*WatchState` driving list query + supervisor + polling gate
- [ ] Generalize supervisor scheduling only; delivery returns `accepted`/`blocked`/`retryable-failure`
- [ ] `blocked` is paused, with an explicit transition back to `merge-observed`

## Arm surface

- [ ] `--self` + `--then` on `notify-on-merge` (`agent-shim/shipit-session.ts`) + worker relay
- [ ] `POST /api/sessions/:id/self-merge-watch` — arms, refuses archived, refuses while a watch is non-terminal, fires `checkAndFireNow` under the lease
- [ ] Container-accessible route golden test

## Delivery

- [ ] `handleSelfMerge` called from `onMergeDetectedCb` after `markMergedAndPruneExcess`, with PR identity
- [ ] Carry `{prNumber, headSha}` into the merge callback (signature change)
- [ ] Identity check on BOTH the merged and `expired` paths
- [ ] Closed outcomes fan out from `onPrTerminalState` → `expireSelfWatch`
- [ ] Restore an evicted workspace before the reset
- [ ] Session-level preparation lease (not a runner flag); counts as `agentBusy`, exempt from `verifyRunningState`
- [ ] Await any in-flight auto-push before mutating the workspace
- [ ] Reset coordinator: consent policy, workspace mutex, re-arm, `reset_eligible`, persisted card
- [ ] Write-ahead stages: `reset-started → local-reset-applied → remote-healed → reset-complete`
- [ ] Remote healing classified (network = retryable, lease conflict = blocked), not best-effort
- [ ] Fail closed on a safety-gate failure (`blocked`, no turn)
- [ ] `self` branch in `buildWakeTurnPrompt`
- [ ] Preserve the `errored` outcome through `wakeSessionWithTurn`
- [ ] Terminal states: `completed` / `failed` / `completed-without-pr`
- [ ] Woken turn's `--self` re-arm refused server-side
- [ ] `reconcilePending` + `PollingGlobalGate` cover self-watches

## Arm card

- [ ] Arm via `emitChatCard`; transitions via `persistCardTransition`
- [ ] Stable `cardId` on the watch; reconcile/history repair the card idempotently
- [ ] Runner-less `persistCardTransition` (the `expired` path starts no turn)
- [ ] `selfMergeWatch` field + `self_merge_watch_card` column + migration + `toRow`/`fromRow`
- [ ] Rehydrate in `loadSessionHistory`; `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`
- [ ] WS type in `TRANSCRIPT_SCOPED_MESSAGES`
- [ ] Client card component + handler; `cancel_self_merge_watch` WS handler

## Tests

- [x] P1 / P2 regressions — `system-turn-queue.test.ts`, `queue-drain.test.ts`
- [ ] P3 — recovery without a process restart
- [ ] `merge-watch.test.ts` — fire-once, terminal-means-ran, expired, blocked, cancel-vs-merge both orderings, check-now-vs-poller, archived, reconcile
- [ ] Generation — docs/202-superseded PR event doesn't consume the new watch
- [ ] Reset — reserved slot, mutex, pending auto-push, crash after force-push
- [ ] Workspace — evicted checkout restored (distinct from idle-reaped container)
- [ ] `polling-global-gate.test.ts` — pending self-watch keeps the gate open
- [ ] Card — arm + transition within the same running turn, then switch/reload
- [ ] Integration — arm → merge → reset + one turn + new PR; re-arm refused; WS disconnect during delivery

## Docs

- [ ] `src/server/shipit-docs/sessions.md` — `--self --then`, one-attempt rule
- [ ] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant; correct its "next poll retries" and "rides the in-memory queue" claims
