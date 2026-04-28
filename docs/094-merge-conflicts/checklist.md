# 094 — Merge Conflicts Checklist

## Phase 1: Git Identity Propagation
- [ ] Pass git identity into session containers at startup (session-worker.ts, container-session-runner.ts)
  - Currently rebase runs on orchestrator side where identity is already available via global git config.
  - Container identity is needed if the agent runs `git commit` via bash inside the container.

## Phase 2: GitManager Rebase + Force Push (Phases 2–3)
- [x] `fetch()` method
- [x] `isAncestor()` method (using merge-base comparison, not --is-ancestor due to simple-git bug)
- [x] `rebase(onto)` method — returns clean or conflicts with file content
- [x] `rebaseContinue()` method
- [x] `rebaseAbort()` method
- [x] `isRebaseInProgress()` method (uses --absolute-git-dir)
- [x] `forcePush()` method (--force-with-lease --set-upstream)
- [x] `stageAll()` method (for staging resolved files)
- [x] `RebaseResult` and `RebaseConflictFile` types

## Phase 3: Unit Tests (git-rebase.test.ts)
- [x] Clean rebase onto updated base — no conflicts
- [x] Rebase with conflicts — returns conflict file list with markers
- [x] Rebase continue after resolution — completes cleanly
- [x] Rebase abort — restores pre-rebase state
- [x] `isRebaseInProgress()` — true during rebase, false otherwise
- [x] Force push with lease — succeeds after rebase
- [x] `isAncestor()` — true for ancestor, false for non-ancestor
- [x] `fetch()` — updates remote tracking branches

## Phase 4: Orchestrator Rebase Service
- [x] `rebaseOntoBase()` service function
- [x] `forcePushAfterRebase()` service function
- [x] `rebaseAbort()` service function
- [x] `isNonFastForwardError()` helper
- [x] `RebaseFlowResult` type

## Phase 5: API Endpoints
- [x] `POST /api/sessions/:id/git/rebase` — start rebase (auto force-push on clean)
- [x] `POST /api/sessions/:id/git/rebase/abort` — abort rebase

## Phase 6: Agent-Driven Conflict Resolution
- [ ] WS handler for orchestrator-driven resolve loop (send agent a message with conflicts, stage + continue on completion)
- [ ] Chat-visible resolution output

## Phase 7: Auto-Detect Divergence
- [x] Detect non-fast-forward in WS handler auto-push (index.ts)
- [x] Detect non-fast-forward in system-turn auto-push (app-lifecycle.ts)
- [x] Emit `git_push_rejected` WS event

## Phase 8: WS Message Types
- [x] `WsGitPushRejected` type
- [x] `WsRebaseStarted` type
- [x] `WsRebaseConflicts` type
- [x] `WsRebaseComplete` type
- [x] `WsRebaseAborted` type
- [x] Added to `WsServerMessage` union

## Phase 9: Client UI
- [x] Git store: `rebaseStatus`, `rebaseConflicts`, `pushRejected` state
- [x] Git store: `startRebase()`, `abortRebase()` actions
- [x] `useMessageHandler` handles all rebase WS messages
- [x] `RebaseBanner` component (push rejected, in progress, conflicts, resolving states)
- [x] Rendered in App.tsx alongside PrLifecycleCard

## Remaining Work
- [ ] Agent-driven conflict resolution loop (Phase 6) — most complex phase
- [ ] Git identity propagation to containers (Phase 1) — needed for agent git operations
- [ ] Integration tests for full rebase flow
- [ ] Integration test for push rejection detection
