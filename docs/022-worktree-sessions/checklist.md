# 022 — Worktree Sessions Checklist

## Phase 1: GitManager & Session Model (Done)

- [x] `GitManager.createWorktree()` — create worktree with new branch
- [x] `GitManager.removeWorktree()` — force-remove a worktree
- [x] `GitManager.listWorktrees()` — list worktrees (porcelain parse)
- [x] `GitManager.merge()` — merge branch, report conflicts, abort on conflict
- [x] `GitManager.deleteBranch()` — delete local branch
- [x] `SessionInfo` — add `branch`, `sessionType` fields
- [x] `SessionManager.setWorktreeInfo()` — set worktree metadata
- [x] Unit tests — 8 tests in `git-worktree.test.ts`

## Phase 2: WS Handlers (Done)

- [x] WS types — `fork_session`, `list_worktrees`, `merge_session` (client→server)
- [x] WS types — `session_forked`, `worktree_list`, `merge_result` (server→client)
- [x] `fork_session` handler — create worktree from shared repo or session dir
- [x] `list_worktrees` handler — find all sessions sharing same `remoteUrl`
- [x] `merge_session` handler — merge worktree branch into active session
- [x] `archive_session` cleanup — remove worktree + delete branch on archive
- [x] Branch name validation — reject spaces, `..`, control chars
- [x] Integration tests — 11 tests in `worktree-sessions.test.ts`

## Phase 3: Shared Repo Clone (Done)

- [x] Shared repo directory — `/workspace/repos/{sha256(repoUrl)}` per unique repo URL
- [x] `home_send_with_repo` — clone to shared dir (first time) or pull (subsequent), then create worktree for every session
- [x] Remove `parentSessionId` from `SessionInfo` — sessions are independent, no parent-child
- [x] `SessionManager.findAllByRemoteUrl()` — find all sessions for same repo
- [x] Archive cleanup uses shared repo dir (from `remoteUrl`) or `.git` file (standalone worktrees)
- [x] Integration test — all sessions are worktrees from single shared clone
- [x] Integration test — worktree session changes are independent

## Phase 4: Edge Cases

- [ ] Graceful error when worktree directory is missing on session resume
- [ ] Shared repo cleanup when all sessions for a repo are archived
