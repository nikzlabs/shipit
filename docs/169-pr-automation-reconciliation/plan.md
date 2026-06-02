---
status: planned
priority: medium
description: Reconcile the auto-fix-CI and auto-resolve-conflicts automations onto a shared state machine and agent-injection path, removing divergence and duplication.
---

# PR automation reconciliation

## Problem

ShipIt has grown three poller-driven PR automations that each "do something to the PR
on the user's behalf when CI/merge state changes":

| Automation | Manager | Agent injection | Toggle scope | Cooldown | Reset on user activity |
|---|---|---|---|---|---|
| Auto-fix CI | `auto-fix-manager.ts` | `runner.dispatch()` (shared system-turn path) | per-session, **in-memory** | ❌ none | ❌ only on new push |
| Auto-resolve conflicts | `auto-conflict-resolve-manager.ts` | bespoke `runRebaseResolutionTurn` (hand-rolled spawn) | global, **persisted** | ✅ 5min / 1min | ✅ `resetForUserActivity` |
| Auto-merge (context) | `auto-merge-manager.ts` | n/a (no agent turn) | per-session | — | — |

They were built incrementally and have **diverged in ways that look incidental
rather than designed**. Two concrete problem classes:

### A. Forked agent-injection lifecycle

- Auto-fix CI reaches the agent through **`runner.dispatch()`** → `runDispatchedTurn`,
  the shared system-turn path that already owns the queue, live-steering
  (`trySteerDispatch` / `shouldSteerMessage`), and the synchronous `_isRunning=true`
  race fix (`session-runner.ts:699`).
- Auto-resolve conflicts **bypasses `dispatch()` entirely**. `runRebaseResolutionTurn`
  (`services/rebase-driver.ts:245`) hand-rolls the whole turn lifecycle: `createAgent`,
  `setAgent` identity-guarding, `running` / `systemTurnInProgress` flag management,
  `agent.on("error"/"done")` teardown, zombie-agent cleanup. This duplicates logic
  `runDispatchedTurn` already owns.

The divergence is **partly justified**: a rebase must NOT auto-commit/auto-push after
the turn (it would corrupt the in-progress rebase), and the orchestrator must drive
`git add -A` + `rebase --continue` between possibly-multiple agent turns. But the
*reason* to fork is "different post-turn behavior" — not "different turn lifecycle".
Today a fix to the turn lifecycle (e.g. the documented `_isRunning` race) has to be
mirrored by hand into the rebase driver.

### B. Duplicated, drifted state machines

`AutoFixManager` (127 lines) and `AutoConflictResolveManager` (497 lines) both
implement: per-session `Map`, `MAX=3`, head-SHA-change attempt reset, a `status`
enum, an `onChange` SSE broadcast, a `handleTransition` called from the poller, and
an `attachAutomationState` block on `PrStatusSummary`. The skeleton is copied.

Worse than the copy, they've drifted in **behavior**:

1. **Toggle model inconsistent.** CI = per-session, transient (lost on orchestrator
   restart), toggled on the PR card. Conflicts = global per-user, persisted in
   `credentialStore`, no per-PR control. A user reasonably expects both "auto-fix my
   PR" switches to live in the same place and persist the same way.
2. **No cooldown on CI autofix.** If a fix turn finishes and CI is still red, the next
   poll re-fires immediately, burning all 3 attempts in quick succession. The conflict
   manager added cooldowns specifically to avoid this; CI never got them.
3. **No `resetForUserActivity` for CI autofix.** Conflicts refreshes the attempt budget
   when the user types; CI only resets on a new push. Inconsistent.

## Goal

One shared abstraction for "poller-driven, attempt-budgeted, agent-backed PR
remediation", with the per-automation differences expressed as explicit, named
configuration rather than incidental drift. Behavior the user sees (toggle location,
persistence, cooldown, reset-on-activity) becomes consistent and intentional.

Non-goals: changing what the CI-fix prompt or conflict prompt says; changing the
rebase git plumbing; merging auto-merge into the same abstraction (it has no agent
turn — only align it where cheap).

## Approach

Two independent workstreams. They can land in either order; B is lower-risk and
higher-visibility, A is the deeper refactor.

### Workstream A — unify the agent-injection path

Give `runner.dispatch()` a way to opt out of post-turn auto-commit/auto-push and to
hand control back to a caller between turns, so the rebase driver can stop forking the
turn lifecycle.

1. Extend `AgentDispatchOptions` (and the `SystemTurnDeps` post-turn hook consumed by
   `runDispatchedTurn`) with an explicit `postTurn` policy:
   - `postTurn: "commit-push"` (default — today's behavior, used by CI fix).
   - `postTurn: "none"` (skip auto-commit / auto-push / queue-drain — for rebase).
2. Add a completion signal to a dispatched turn (a `Promise<void>` resolved on the
   turn's `done`, or an `onTurnComplete` callback) so a multi-turn driver like the
   rebase loop can `await` one resolution turn, run its git step, then dispatch the
   next. This is the one capability `runRebaseResolutionTurn` has that `dispatch()`
   (fire-and-forget) lacks today.
3. Rewrite `runRebaseResolutionTurn` to call `runner.dispatch({ text: prompt,
   activity, postTurn: "none" })` and await completion, deleting the hand-rolled
   `createAgent`/`setAgent`/`running`-flag/`on("done")`/`on("error")`/timeout-teardown
   blocks. The rebase-specific orchestration (`stageAll` + `rebaseContinue` loop,
   `MAX_REBASE_ITERATIONS`, force-push, abort-on-error) stays in the driver — only the
   *turn lifecycle* moves to the shared path.
4. Verify the auto-resolve wall-clock timeout teardown (`runAutoResolveAttempt`,
   `rebase-driver.ts:447`) still works — it kills the agent and resets runner state;
   confirm the shared path exposes enough to do this (or move the teardown to be a
   property of the dispatched turn).

Net: the synchronous-`running` race fix, live-steering suppression, and chat-history
grouping all live in exactly one place; the rebase driver shrinks to git plumbing.

### Workstream B — unify the state machine + toggle model

1. Extract a shared base, e.g. `AutoRemediationManager<TState>` (or a
   `createRemediationStateMachine(config)` factory) capturing the common skeleton:
   per-session `Map`, `MAX_ATTEMPTS`, head-SHA-change reset, `status` enum, cooldown
   gate, `resetForUserActivity`, `onChange` broadcast, and the `attachAutomationState`
   contribution. Per-automation config supplies: the trigger predicate (CI failed vs.
   `mergeable === "conflicting"`), the `fire` callback, cooldown durations, and the
   `PrStatusSummary` field name.
2. Reimplement `AutoFixManager` and `AutoConflictResolveManager` as thin specializations
   of the base. The conflict manager's richer features (deferred state,
   `lastKnownMergeable` flap-suppression, `pendingReset`, deferred-emit dedup,
   `onRunnerIdle` re-eval) become **opt-in capabilities of the base**, not bespoke code
   — so CI fix can adopt the ones that make sense for it.
3. **Give CI autofix a cooldown** (adopt `AUTO_FIX_COOLDOWN_MS`) so a sticky red CI
   doesn't burn 3 attempts in seconds.
4. **Give CI autofix `resetForUserActivity`** wiring in `index.ts` alongside the
   conflict reset (`send_message` / `answer_question` / `send_review_message`).
5. **Decide the toggle model and make both consistent** — see Open question 1. Whatever
   we pick, both features use it. If we go per-session+persisted, persist the auto-fix
   map (it's currently lost on restart) and add a per-session conflict toggle to the
   card; if we go global+persisted, move the CI toggle to settings.

## Key files

- `src/server/orchestrator/auto-fix-manager.ts` — collapses into a base specialization.
- `src/server/orchestrator/auto-conflict-resolve-manager.ts` — collapses into a base specialization.
- `src/server/orchestrator/auto-merge-manager.ts` — align `attachAutomationState` shape only; no agent turn.
- `src/server/orchestrator/session-runner.ts` — `dispatch()` + `AgentDispatchOptions` gain `postTurn` policy + completion signal.
- `src/server/orchestrator/ws-handlers/dispatched-turn.ts` — honor `postTurn: "none"`.
- `src/server/orchestrator/services/rebase-driver.ts` — `runRebaseResolutionTurn` rewritten on top of `dispatch()`; git plumbing unchanged.
- `src/server/orchestrator/pr-status-poller.ts` — `attachAutomationState` (712), `handleTransition` call sites (992, 1003); construct managers via the shared base.
- `src/server/orchestrator/app-lifecycle.ts` — callback wiring for both managers.
- `src/server/orchestrator/credential-store.ts` / `services/settings.ts` — toggle persistence (depends on Open question 1).
- `src/server/orchestrator/index.ts` — `resetForUserActivity` fan-out for CI fix (~1736).
- `src/client/components/PrStatusControls.tsx` / `PrLifecycleCard.tsx` / `stores/pr-store.ts` / `stores/settings-store.ts` — toggle UI consistency.
- Tests: `integration_tests/pr-ci-fix.test.ts`, the auto-resolve tests, and new shared-base unit tests.

## Risks

- **Rebase post-turn semantics are load-bearing.** The whole reason the driver forked
  was that auto-commit mid-rebase corrupts the rebase. Workstream A must prove
  `postTurn: "none"` truly elides commit/push/drain on every exit path (success, agent
  error, timeout) before deleting the hand-rolled lifecycle. Land A behind tests that
  assert no commit happens during a conflict turn.
- **The conflict manager's race comments are subtle** (the step-11 ordering, the
  synchronous "idle" re-entrancy in `verifyRunningState`). The base extraction must
  preserve that ordering — port the existing tests first, refactor under green.
- **Toggle migration** — if we persist the auto-fix map or move toggles, handle
  existing in-flight sessions gracefully (default off, no surprise re-enables).

## Open questions

1. **Toggle model** — per-session+persisted, or global+persisted, for both? (Leaning
   per-session+persisted: matches the PR-card mental model and lets a user enable
   auto-fix on one risky PR without it firing everywhere. Requires persisting the
   auto-fix map and adding a per-session conflict toggle.)
2. **Scope of the shared base** — full generic base class, or a lighter shared-helpers
   module (cooldown gate, SHA-reset, attach-state) that both managers call? The latter
   is less invasive and preserves the conflict manager's careful ordering with less
   risk. Decide after reading the conflict manager's tests.
3. **Auto-merge** — fold its `attachAutomationState` block into the same shape, or
   leave it alone since it has no agent turn? (Probably leave the manager; only share
   the SSE-attach helper.)
