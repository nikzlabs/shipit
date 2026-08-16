# 266 — Merge-time reset notice: checklist

- [x] `emitResetEligible` returns the full `ResetEligibility` (one git pass feeds both the
      signal and the notice)
- [x] `announceResetStateOnMerge` replaces `emitResetEligibleSignal`: signal + merge-time
      refusal notice (req 1)
- [x] `buildMergeTimeSkipNotice` — merge-time wording, carrying the gate's own detail (reqs 2, 3)
- [x] Notice persisted with no live runner; `persistNoticeUnattached` in
      `chat-card-persistence.ts` (req 5)
- [x] Merge-detection call site resolves the session dir from the runner or `workspaceDir`
- [x] Refusal-episode map keyed by clause; `skipped()` drops the repeat, keeps the log line and
      the agent prefix (req 4)
- [x] Episode cleared on reset / already-at-base / un-merged / eligible / failed delivery
- [x] `ResetSkipInfo.notice` optional; hook guards on it
- [x] Tests: merge-time notice content, in-turn vs unattached persistence, the clause set,
      no-double-notify, a different clause re-notifies, the opt-out exemption, dropped-notice
      logging, fail-safe on a git throw
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Independent review against every numbered requirement

From that review (each fixed, each with a regression test):

- [x] The episode key now carries the MERGE it belongs to, so an entry a resolving path never
      cleared cannot silence a later merge's notice (req 1)
- [x] `announceResetStateOnMerge` wrapped end to end — a throwing viewer transport no longer
      rejects into `onMergeDetectedCb` and skip the bare-cache refresh that follows (req 7)
- [x] A failed late transcript write releases the claim, so a storage blip cannot silence every
      later turn under the same refusal (req 4)
- [x] `clearResetSkipEpisode` on an explicit `shipit branch reset-to-base` success too
- [x] Tests for the two clauses that need no git failure (`no-base-branch`,
      `no-merged-head-sha`)
