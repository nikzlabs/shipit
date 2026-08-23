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
