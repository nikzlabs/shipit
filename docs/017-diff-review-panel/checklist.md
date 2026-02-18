# 017 — Diff Review Panel: Remaining Work

Nothing has been implemented yet. `DiffBlock.tsx` (inline chat diffs) is unrelated.

## Remaining

- [ ] Add `DiffFileStat`, `DiffHunk`, `DiffLine`, `FileDiff`, `WsGetTurnDiff`, `WsRejectChanges`, `WsDiffComment`, `WsTurnDiff` types to `src/server/types.ts`
- [ ] Add `diff()`, `diffStat()`, `checkoutFile()` methods to `src/server/git.ts`
- [ ] Add `get_turn_diff`, `reject_changes`, `diff_comment` handlers in `src/server/index.ts`
- [ ] Create `src/client/components/DiffPanel.tsx` (file list, unified diff view, inline commenting, accept/reject buttons)
- [ ] Create `src/client/components/DiffPanel.test.tsx`
- [ ] Add `turnDiff` / `showDiffPanel` state, "Review Changes" badge trigger on `git_committed`, and panel wiring in `src/client/App.tsx`
- [ ] Create `src/server/integration_tests/diff-review.test.ts` (happy path, reject changes, diff comment, empty diff, binary files)
