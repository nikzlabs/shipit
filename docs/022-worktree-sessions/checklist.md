# 022 — Worktree Sessions Checklist

## Phase 1: Backend — Fork & Switch (Done)

- [x] `GitManager.createWorktree()` — create worktree with new branch
- [x] `GitManager.removeWorktree()` — force-remove a worktree
- [x] `GitManager.listWorktrees()` — list worktrees (porcelain parse)
- [x] `GitManager.merge()` — merge branch, report conflicts, abort on conflict
- [x] `GitManager.deleteBranch()` — delete local branch
- [x] `SessionInfo` — add `parentSessionId`, `branch`, `sessionType` fields
- [x] `SessionManager.getChildren()` — find child worktree sessions
- [x] `SessionManager.setWorktreeInfo()` — set worktree metadata
- [x] WS types — `fork_session`, `list_worktrees`, `merge_session` (client→server)
- [x] WS types — `session_forked`, `worktree_list`, `merge_result` (server→client)
- [x] `fork_session` handler — create worktree, track session, copy remote/identity
- [x] `list_worktrees` handler — resolve parent chain, list all family worktrees
- [x] `merge_session` handler — merge worktree branch into active session
- [x] `archive_session` guard — block archiving parent with active worktree children
- [x] `archive_session` cleanup — remove worktree + delete branch on child archive
- [x] Branch name validation — reject spaces, `..`, control chars
- [x] Unit tests — 8 tests in `git-worktree.test.ts`
- [x] Integration tests — 12 tests in `worktree-sessions.test.ts`

## Phase 2: Client — Fork Session UI

- [ ] Handle `session_forked` message in `App.tsx` `lastMessage` effect
- [ ] Handle `worktree_list` message in `App.tsx`
- [ ] Handle `merge_result` message in `App.tsx` (show success/conflict toast)
- [ ] `ForkSessionModal` component — branch name input, optional start point
- [ ] `ForkSessionModal` tests — render, validation, submit callback
- [ ] Add "Fork Session" button to session header or session selector
- [ ] `send()` wiring for `fork_session` from modal submit

## Phase 3: Client — Session List Grouping

- [ ] Group worktree sessions under parent in `SessionSelector`
- [ ] Show branch name badge on worktree sessions
- [ ] Show "Merge" button on worktree sessions
- [ ] Show worktree indicator icon (branch icon) vs standalone
- [ ] Disable archive on parent sessions that have children (client-side guard)
- [ ] `SessionSelector` tests — grouped rendering, merge button, branch badges

## Phase 4: Polish & Edge Cases

- [ ] Handle stale worktree references (parent deleted outside ShipIt)
- [ ] Graceful error when worktree directory is missing on session resume
- [ ] Show merge conflict file list in UI when merge fails
- [ ] Auto-switch to parent session after successful merge
- [ ] Update `docs/001-websocket-protocol/plan.md` with new message types
