# 017 — Diff Review Panel: Remaining Work

All items complete. Uses Monaco DiffEditor in readonly mode for side-by-side diff rendering.

## Completed

- [x] Add `DiffFileStat`, `FileDiff`, `WsGetTurnDiff`, `WsRejectChanges`, `WsDiffComment`, `WsTurnDiff`, `WsRejectChangesComplete` types to `src/server/types/`
- [x] Add `getFileAtCommit()`, `diffNameStatus()`, `checkoutFiles()` methods to `src/server/git.ts`
- [x] Add `get_turn_diff`, `reject_changes`, `diff_comment` handlers via `src/server/ws-handlers/diff-handlers.ts` and `src/server/index.ts`
- [x] Create `src/client/components/DiffPanel.tsx` (file list sidebar, Monaco DiffEditor readonly, accept/reject buttons, per-file checkboxes)
- [x] Create `src/client/components/DiffPanel.test.tsx` (18 tests)
- [x] Add `turnDiff` / `lastCommitPair` / `diffBadgeCount` state, "Changes" tab trigger on `git_committed`, and panel wiring in `src/client/App.tsx`, `useMessageHandler.ts`, `useAppCallbacks.ts`
- [x] Create `src/server/integration_tests/diff-review.test.ts` (9 tests: happy path, added/deleted/multiple files, reject specific/all, error paths, empty diff)
