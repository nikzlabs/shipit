# 022 — Worktree Sessions Checklist

## Phase 1: GitManager & Session Model (Done)

- [x] `GitManager.createWorktree()` — create worktree with new branch
- [x] `GitManager.removeWorktree()` — force-remove a worktree
- [x] `GitManager.listWorktrees()` — list worktrees (porcelain parse)
- [x] `GitManager.merge()` — merge branch, report conflicts, abort on conflict
- [x] `GitManager.deleteBranch()` — delete local branch
- [x] `SessionInfo` — add `parentSessionId`, `branch`, `sessionType` fields
- [x] `SessionManager.getChildren()` — find child worktree sessions
- [x] `SessionManager.setWorktreeInfo()` — set worktree metadata
- [x] Unit tests — 8 tests in `git-worktree.test.ts`

## Phase 2: WS Handlers (Done)

- [x] WS types — `fork_session`, `list_worktrees`, `merge_session` (client→server)
- [x] WS types — `session_forked`, `worktree_list`, `merge_result` (server→client)
- [x] `fork_session` handler — create worktree, track session, copy remote/identity
- [x] `list_worktrees` handler — resolve parent chain, list all family worktrees
- [x] `merge_session` handler — merge worktree branch into active session
- [x] `archive_session` guard — block archiving parent with active worktree children
- [x] `archive_session` cleanup — remove worktree + delete branch on child archive
- [x] Branch name validation — reject spaces, `..`, control chars
- [x] Integration tests — 12 tests in `worktree-sessions.test.ts`

## Phase 3: Transparent Worktree in `home_send_with_repo` (Done)

- [x] `SessionManager.findByRemoteUrl()` — find existing non-archived session by remote URL
- [x] Modify `home_send_with_repo` — if existing clone found, use `createWorktree` instead of `git clone`
- [x] Set `sessionType: "worktree"`, `parentSessionId`, `branch` on worktree sessions
- [x] Pull latest from remote in parent before creating worktree (so worktree starts up-to-date)
- [x] Integration test — second `home_send_with_repo` for same repo creates worktree, not clone
- [x] Integration test — worktree session gets correct remote URL and credentials
- [x] Integration test — worktree session is independent (changes don't affect parent)

## Phase 4: Edge Cases

- [ ] Handle stale parent (parent session archived/deleted but worktree references it)
- [ ] Graceful error when worktree directory is missing on session resume
- [ ] Fetch latest remote changes before creating worktree from parent
