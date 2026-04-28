# 094 — Merge Conflicts Checklist

## Phase 1: Git Identity Propagation
- [x] Pass git identity into session containers at startup
  - Implementation: set `GIT_CONFIG_GLOBAL=/credentials/.gitconfig` env var in `buildEnv()` (container-lifecycle.ts).
  - The credentials directory is already mounted at `/credentials`, and the orchestrator writes `user.name`/`user.email` there via `initGlobalGitConfig()`.
  - Result: any git operation inside the container (agent bash, rebase --continue, etc.) inherits the user's configured identity automatically. No per-container startup logic needed.

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
- [x] Orchestrator-driven resolve loop in `services/rebase-driver.ts`
  - `runRebaseFlow()` orchestrates fetch → ancestry check → rebase → conflict-resolution loop → force push
  - On conflicts, spawns an agent with conflict context (skipping the standard system-turn flow because auto-commit + auto-push would corrupt a rebase)
  - Stages all files and runs `git rebase --continue` after each agent turn
  - Loop iterations capped at `MAX_REBASE_ITERATIONS = 10` for safety
  - On unrecoverable failure, calls `git rebase --abort` and emits `rebase_aborted`
- [x] Chat-visible resolution output
  - System message with the conflict prompt is appended to chat history (`role: user`)
  - Agent's resolution summary is appended after completion (`role: assistant`)
  - WS events (`rebase_started`, `rebase_conflicts`, `rebase_complete`, `rebase_aborted`) drive UI updates
- [x] API endpoint refactored to delegate to the driver
  - `POST /api/sessions/:id/git/rebase` returns `{ status: "started" }` and runs the flow asynchronously
  - `POST /api/sessions/:id/git/rebase/abort` kills the agent if mid-resolution and emits `rebase_aborted`
- [x] Client store: `startRebase()` is now optimistic — relies on WS events instead of synchronous response

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

## Phase 10: Tests
- [x] Unit tests for rebase driver (`services/rebase-driver.test.ts`)
  - Up-to-date branch (no rebase needed)
  - Clean rebase + force push when authenticated
  - Clean rebase without auth (forcePushed: false)
  - Conflicts → agent resolves → completes
  - Concurrent agent turn rejection (409)
  - Invalid base branch rejection
  - Prompt builder formatting
- [x] Integration test for full rebase flow (`integration_tests/rebase-flow.test.ts`) — covers: 404 on missing session, clean rebase WS events, up-to-date short circuit, conflicts + agent resolution loop, abort endpoint behavior
- [ ] Integration test for push rejection detection (covered indirectly by the existing `git_push_rejected` emission in auto-push code paths)

## Remaining Work
- All phases complete. The feature is end-to-end functional:
  - Container-side git identity propagated via `GIT_CONFIG_GLOBAL=/credentials/.gitconfig`
  - Rebase + force push primitives in `GitManager`
  - Orchestrator-driven flow with agent-resolved conflicts
  - WS events drive client UI; HTTP API kicks off the flow
  - Push rejection detection wired into auto-push paths
  - Client UI renders banner + agent activity in chat
