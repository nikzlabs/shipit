# Checklist — docs/181 merged-session grouping

- [x] Server `reopenedAfterMerge` keys on `prState === "open"`, not `last_used_at > merged_at`
- [x] Parse `prState` into `SessionInfo` from the persisted `pr_status` column (`fromRow`)
- [x] `markMerged` un-frozen + idempotent via GitHub's `merged_at` (thread through poller → service)
- [x] UTC-normalize the merged-ranking sort in `filterVisibleInSidebar`
- [x] Client mirror (`SessionSidebar.tsx`) reads current PR state from the pr-store
- [x] Server unit tests: `reopenedAfterMerge` (prState cases) + `markMerged` (fresh/idempotent/fallback)
- [x] Server unit test: `list()` no longer reopens on a bare `last_used_at` bump; reopens on an OPEN follow-up PR
- [x] Client tests: reopened (open PR) stays Active; merged-then-poked demotes to Recently merged
- [x] Update poller/integration tests for the new `onMergeDetectedCb(sessionId, mergedAt)` signature
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck` green
