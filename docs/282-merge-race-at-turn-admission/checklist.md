# Merge race at turn admission — checklist

- [x] `services/pre-turn-merge-recheck.ts` — the two local gates, the bounded
      probe, the fail-safe swallow.
- [x] Export `checkResetPreconditions` so the recheck's local gate is the reset's
      own definition rather than a copy.
- [x] `PrStatusPoller.awaitMergeHandling` + the tracked `onMergeDetectedCb`
      promise, so the recheck waits for `merged_at` rather than racing it.
- [x] `forceVerifySessionPrState`'s `armAbsentDebounce` option, so the recheck
      cannot wedge detection of the NEXT merge.
- [x] Call the recheck from `applyPreTurnReset`, ahead of the gate, for both
      transports.
- [x] Reproduce the race in `pre-turn-reset-hook.test.ts` (fails without the fix).
- [x] Unit tests for every state that must cost no round-trip, plus error /
      timeout / late-rejection fail-safes.
- [x] Poller tests for `awaitMergeHandling` and the un-armed debounce.
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`.
- [x] Cross-reference from `docs/218-auto-reset-merged-branch-on-continue/plan.md`.

## From the independent review

- [x] Three-valued outcome: an expired budget that leaves the merge bookkeeping
      in flight must NOT reset, or the force-push races the pending head-branch
      delete. Guarded by a hook test that fails without it.
- [x] `mergeHandling` lifecycle: cleared on `reArm` and `untrackSession`, so a
      handler that never settles cannot tax every later turn. Guarded.
- [x] A remote-tracking ref that does not resolve no longer excludes the probe.
- [x] Dropped the redundant `work.catch` in `withTimeout` and the test that
      claimed to guard it — `Promise.race` already handles a late-rejecting
      loser, so neither could ever fail.
- [x] Corrected the timeout rationale: the awaited callback work is the
      head-branch delete, not container pruning or the bare-cache refresh.
