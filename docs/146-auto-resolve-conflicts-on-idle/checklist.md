# 146 — Checklist

Tracking the work for auto-resolve conflicts on idle. Mark items `[x]` as they land.

## Server — manager

- [x] Add `AutoConflictResolveManager` in `src/server/orchestrator/auto-conflict-resolve-manager.ts` — state map, `lastKnownMergeable` cache, `MAX_AUTO_RESOLVE_ATTEMPTS`, `AUTO_RESOLVE_COOLDOWN_MS`, `AUTO_RESOLVE_DEFERRED_COOLDOWN_MS`.
- [x] Implement `handleTransition` (steps 1–12 per plan): unknown-skip, cache snapshot/write, global-enabled gate, first-seen init, running/exhausted short-circuits, head-SHA reset, conflict-resolved cleanup, cap gate, cooldown gate, pre-attempt runner gate with `verifyRunningState` re-entrancy handling, fire callback with no in-place attempt increment.
- [x] Implement `onRunnerIdle` (only re-evaluates `deferred` state) and `resetForUserActivity` (clears budget/cooldown/lastError, deferred reset via `pendingReset` flag when running).
- [x] Implement `writeBack` — single increment site, terminal status writes, `nextEligibleAt` cooldowns (including `force_push_failed` cooldown), per-attempt WS `auto_resolve_result` envelopes including `exhausted`, dedup back-to-back deferred emits via `lastEmittedDeferred`, SSE re-broadcast via `onChange`, guard on disabled-mid-run (suppress WS emit but still write state).
- [x] Implement `get(sessionId)`, `delete(sessionId)`, `setRebaseAndResolveCb`.

## Server — rebase wrapper

- [x] Add `runAutoResolveAttempt` in `src/server/orchestrator/services/rebase-driver.ts` next to `runRebaseFlow`: takes `RebaseDriverDeps` + `timeoutMs?` + `now?`, returns `AutoResolveResult`.
- [x] Wrapper pre-flights: `git.isClean()` (dirty tree → deferred), `git.isRebaseInProgress()` (abort + deferred), `!githubAuthManager.authenticated` (deferred).
- [x] Wrapper post-`runRebaseFlow` translation: `up_to_date` → deferred (suppress `auto_resolve_result` emit on this path), `rebased`/`conflicts_resolved` → success with `forcePushed`, 409 ServiceError → deferred, fetch-failure (pre-spawn throws) → deferred via `didSpawn` flag.
- [x] Wall-clock timeout teardown (default 10 min): kill agent, `setAgent(null)`, `running = false`, `onAgentFinished()`, `git.rebaseAbort()`, `runner.emitMessage({ type: "rebase_aborted" })`, resolve with `{ outcome: "error", lastError: "timeout", didWork: true }`.
- [x] Emit `auto_resolve_started` via `runner.emitMessage` at attempt start.
- [x] Extend `RebaseDriverDeps` with optional `onAgentSpawned?: () => void`; fire from `runRebaseResolutionTurn` immediately after `runner.setAgent(agent)`.

## Server — doc-094 follow-on (required by 146)

- [x] In `runRebaseResolutionTurn`'s `done` handler: after `runner.onAgentFinished()`, drain the next queued message via the same call site `agent-execution.ts` uses (pass a drain callback through `RebaseDriverDeps` rather than coupling the driver to the WS layer).
- [x] Suppress live steering while a system-driven (rebase-resolution / dispatched) turn is in flight: add a `runner.systemTurnInProgress` flag flipped true at `setAgent(agent)` and false at `done`; the send-message handler checks it and forces queue instead of inject, so steered user input doesn't derail conflict resolution. Drain then handles the queued message after the resolve turn finishes.

## Server — git helper

- [x] Add public `GitManager.isClean()` to `src/server/shared/git.ts` (thin wrapper around `this.git.status()`).

## Server — poller wiring

- [x] Instantiate `AutoConflictResolveManager` in `PrStatusPoller`'s constructor only when `runnerRegistry` is present; expose as public field `autoConflictResolveManager`.
- [x] Call `autoConflictResolveManager.handleTransition(...)` after the existing `autoFix.handleTransition(...)` per tracked session.
- [x] Call `autoConflictResolveManager.delete(sessionId)` from `untrackSession` AND from `verifyMissingPr`'s terminal-state branch (next to `mergedSessions.add`).
- [x] Extend `attachAutomationState` to attach `autoResolve` block from `autoConflictResolveManager.get(sessionId)` — and omit the block when `isGlobalEnabled()` is false.
- [x] Add `broadcastAllSnapshots()` method for the settings-flip-on re-broadcast.

## Server — runner-idle hook

- [x] In `runner-registry-factory.ts`, extend the existing `onRunnerIdle` closure to also call `autoConflictResolveManager.onRunnerIdle(sessionId)`.
- [x] Add `getAutoConflictResolveManager?: () => AutoConflictResolveManager | undefined` to `RunnerRegistryDeps`.
- [x] Wire from `index.ts` via `() => prStatusPollerRef.ref?.autoConflictResolveManager`.

## Server — app lifecycle wiring

- [x] Construct `RebaseAndResolveCb` in `app-lifecycle.ts` near `fetchAndFixCb`: closure resolves runner via registry, constructs `RebaseDriverDeps` per call, invokes `runAutoResolveAttempt`.
- [x] Inject into manager via `setRebaseAndResolveCb`.

## Server — user-activity reset wiring

- [x] In the WS dispatch switch in `src/server/orchestrator/index.ts`, call `prStatusPoller?.autoConflictResolveManager?.resetForUserActivity(sessionId)` inside the `send_message`, `send_review_message`, and `answer_question` cases (before delegating).
- [x] In `POST /api/sessions/:id/git/rebase` (user-driven rebase), call `resetForUserActivity(sessionId)` at the top.

## Server — global setting

- [x] Add `getAutoResolveConflicts()` / `setAutoResolveConflicts()` to `credential-store.ts` (mirror `getAutoCreatePr`).
- [x] Add `autoResolveConflicts?: boolean` to `CredentialData`.
- [x] Add `autoResolveConflicts: boolean` to `GlobalSettings` in `services/types.ts`.
- [x] Refactor `saveGlobalSettings` from positional parameters to an options object (touches `services/settings.ts` + every call site).
- [x] Read/write `autoResolveConflicts` in `getGlobalSettings` / `saveGlobalSettings`.
- [x] Extend `PUT /api/settings` `Body` type and call site in `api-routes-bootstrap.ts`.
- [x] On `autoResolveConflicts` false → true flip inside `saveGlobalSettings`, call `prStatusPoller.broadcastAllSnapshots()`.

## Server — retry route

- [x] Add `POST /api/sessions/:id/auto-resolve/retry` in `api-routes-git.ts`. Synchronously: (1) `resetForUserActivity(sessionId)`; (2) immediately fire `handleTransition` with the cached `lastKnownMergeable` value. Returns 409 when `status === "running"`.

## Server — types

- [x] Add `autoResolve?: { status, attemptCount, maxAttempts, lastError?, nextEligibleAt? }` to `PrStatusSummary` in `github-types.ts`.
- [x] Add `WsAutoResolveStarted` and `WsAutoResolveResult` to `ws-server-messages.ts`.

## Client

- [x] Add `autoResolveConflicts` (boolean) + setter to `settings-store.ts`.
- [x] Add toggle row to `Settings.tsx` in the same group as Auto-create PR / Live steering, with the copy from the plan.
- [x] Wire `auto_resolve_result` envelope into the per-session message handler so the PR-store sees terminal outcomes (parallels `autoFix`).
- [x] Render failure sub-banner in `PrLifecycleCard.tsx` only for `outcome: "exhausted"`. Shows `lastError`, `[Retry]` button (no conflict-files link). Retry button hits the new HTTP route.
- [x] Banner gated on `settings.autoResolveConflicts === true` AND `summary.autoResolve?.status === "exhausted"`.

## Tests

- [x] Unit tests for `auto-conflict-resolve-manager.test.ts` — all 18 scenarios listed in the plan (unknown-poll handling, edge cases, exhaustion semantics, cache snapshot ordering, first-enable correctness, etc.).
- [x] Integration tests in `integration_tests/auto-resolve-conflicts.test.ts` — all 9 scenarios listed in the plan (happy path, disabled, busy/idle re-evaluation, exhaustion, timeout teardown, no-auth pre-flight, lease rejection, up_to_date race, two-session parallel).
- [x] Re-entrancy unit test: `verifyRunningState` synchronously emits `"idle"` mid-`handleTransition`; assert callback fires exactly once across the whole call.

## Docs

- [x] Update `docs/113-pr-mergeable-state/plan.md`'s Out-of-scope section to cross-reference doc 146 (deliberate reversal of the "no auto-firing" decision).
- [x] Update `docs/146-auto-resolve-conflicts-on-idle/plan.md` frontmatter to `status: in-progress` while the work is underway, then `status: done` when the checklist is complete.

## Quality gate

- [x] `npm run lint:dev`
- [x] `npm run typecheck`
- [x] `npm run test:dev`
