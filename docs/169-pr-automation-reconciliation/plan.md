---
description: Reconcile the auto-fix-CI and auto-resolve-conflicts automations onto a shared state machine and agent-injection path, removing divergence and duplication.
issue: https://linear.app/shipit-ai/issue/SHI-62
---

# PR automation reconciliation

> **Status:** Implemented (all three workstreams). New modules:
> `auto-remediation-manager.ts` (shared template-method base) and
> `auto-remediation-arbiter.ts` (cross-automation mutual exclusion +
> await-fresh-signal). `AutoFixManager` and `AutoConflictResolveManager` are now
> thin specializations of the base; the rebase driver's conflict turn runs
> through the shared `dispatch()` path (`postTurn: "none"`, `systemTurn: true`,
> `onTurnComplete`); the auto-fix toggle is the global `autoFixCi` setting. See
> `checklist.md` for the per-item status.

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
2. **CI autofix never re-arms within a head SHA — it fires at most once.** `markRunning`
   sets `status = "running"` (`auto-fix-manager.ts:69`), and the only thing that flips
   it back is CI turning green (`status === "running" && checks.state === "success"`,
   line 101) or a head-SHA change resetting to `idle` (line 92). There is no
   turn-completion reset and no `onRunnerIdle` re-eval wired for auto-fix (only the
   conflict manager gets one, `runner-registry-factory.ts:233`). So when a fix turn
   finishes and CI is *still* red on the same head, status stays `"running"`, the
   failure branch's `state.status !== "running"` gate (line 109) is false, and the loop
   wedges — it never reaches attempts 2 or 3. The advertised 3-attempt budget is
   effectively a 1-attempt budget. (Note: this means a cooldown alone does NOT fix
   anything — the loop must first be able to re-arm after a turn; see Workstream B.)
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

## Resolved decisions

1. **Toggle model → global + persisted, for both.** Auto-fix CI moves off the
   per-session in-memory map onto the same global, `credentialStore`-persisted setting
   shape as auto-resolve conflicts. Both become account-level switches in settings (not
   per-PR-card toggles), and both survive an orchestrator restart. The per-session
   auto-fix toggle on the PR card is removed in favor of the global setting.
2. **Shared base → full generic base class** (not just shared helpers). The deciding
   factor is the mutual-exclusion requirement (Workstream C): suppressing one automation
   while another acts needs a single owner that sees all automations, and a generic base
   is the natural home for the shared per-session arbiter. The conflict manager's subtle
   race ordering is ported into the base under green tests (see Risks).
3. **Auto-merge → leave the manager, share attach only.** `AutoMergeManager` keeps its
   own logic (it never spawns an agent turn), but its `PrStatusSummary` contribution
   routes through the same shared attach-state helper for consistency. It participates in
   the arbiter only as a cheap precondition check (don't merge while a remediation turn
   is in flight); it is not folded into the base.

## Approach

Three workstreams. A and B can land in either order; C depends on B's shared base.
B is lower-risk and higher-visibility, A is the deeper refactor, C is the new
cross-automation guarantee the user asked for.

### Workstream A — unify the agent-injection path

Give `runner.dispatch()` a way to opt out of post-turn auto-commit/auto-push and to
hand control back to a caller between turns, so the rebase driver can stop forking the
turn lifecycle.

1. Extend `AgentDispatchOptions` with an explicit `postTurn` policy and thread it down
   to the shared turn runner. The post-turn commit/push/drain does NOT live in the
   dispatch adapter — it lives in `executeAgentTurn` (`turn-executor.ts`), through which
   BOTH the WS path and the dispatch path (`dispatched-turn.ts` is a thin adapter that
   just calls `executeAgentTurn`) funnel. The policy must gate `runCommitAndPr`
   (`turn-executor.ts:249`), `scheduleAutoPush` (line 222), and the `tryDrain` calls
   (lines 284-285, 364-365) inside `executeAgentTurn`:
   - `postTurn: "commit-push"` (default — today's behavior, used by CI fix).
   - `postTurn: "none"` (skip auto-commit / auto-push / queue-drain — for rebase).
1a. **Carry `systemTurnInProgress` into the dispatch path.** This flag is the *sole*
    mechanism that suppresses live-steering during a system turn: `shouldSteerMessage`
    returns false only when it is set (`dispatch-steering.ts:45,70`), and today it is
    set/cleared *exclusively* inside `runRebaseResolutionTurn` (`rebase-driver.ts:269`
    + the done/error/timeout clears). The dispatch path (`dispatch` → `runDispatchedTurn`)
    does **not** set it. So if Workstream A moves the rebase turn onto `dispatch()` and
    deletes its flag management (step 3), a concurrent user `send_message` during conflict
    resolution would become steer-eligible and inject into the rebase turn, derailing it.
    Therefore `dispatch()` must set `runner.systemTurnInProgress = true` on entry and
    clear it on completion for system turns — gated by an explicit `systemTurn: true`
    dispatch option (cleaner than overloading `postTurn`, since a future caller could want
    one without the other). Set the flag synchronously, in the same tick as the
    `_isRunning = true` flip, so a `send_message` arriving in the gap sees it. Audit the
    existing CI-fix dispatch turns: today they run without `systemTurnInProgress` set, so
    a user message mid-CI-fix is steer-eligible — decide whether CI fix should also be a
    `systemTurn: true` (almost certainly yes, for consistency) and note any behavior
    change.
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
3. **Make CI autofix re-arm after a turn, then add a cooldown.** This is two changes
   and the ordering matters:
   (a) Add a **post-turn status transition** so the loop leaves `"running"` once a fix
   turn completes (the analog of the conflict manager's `writeBack`). Without this the
   loop wedges after one attempt and the 3-attempt budget is never spent (see Problem
   B2). The shared base owns this transition for all automations.
   (b) Only *then* does a cooldown make sense: add `AUTO_FIX_COOLDOWN_MS` so that once
   the loop can re-arm, a still-red CI doesn't immediately re-fire and burn the
   remaining attempts in seconds.
4. **Give CI autofix `resetForUserActivity`** wiring in `index.ts` alongside the
   conflict reset (`send_message` / `answer_question` / `send_review_message`).
5. **Move the auto-fix toggle to global + persisted** (decision 1): add an
   `autoFixCi` (or similarly named) flag to `credentialStore` / `services/settings.ts`
   mirroring `autoResolveConflicts`, expose it in `settings-store.ts` and the settings
   UI, and remove the per-session `AutoFixToggle` from the PR card. Managers read the
   global flag at decision time (as the conflict manager already does) rather than
   mirroring it per-session. Handle migration gracefully: default off, no surprise
   re-enables for sessions that had it toggled on in the old per-session map.

### Workstream C — cross-automation arbitration (mutual exclusion)

The user requirement: two auto-changes must not act on the same head, and once one
acts and pushes, the other stays suppressed until fresh code (a new head SHA) lands.

1. Add a per-session **remediation arbiter** owned by the shared base. Automations
   `claim(sessionId, headSha)` before firing and `release()` when the attempt settles.
   At most one claim per session at a time — a second automation's `handleTransition`
   defers while a claim is held. (This is the logical layer above the existing
   `runner.running` turn-level gate, which already prevents two agent turns at once.)
2. **Await-fresh-signal after a push.** When a claim's attempt force-pushes / pushes
   (head SHA will change), the arbiter marks the session "awaiting fresh signal" and
   suppresses ALL automations until the poller next observes a head SHA different from
   the one that was acted on — i.e. GitHub has recomputed CI status and mergeability
   for the new code. This keys off head SHA, composing with each manager's existing
   reset-on-push logic rather than duplicating it.
3. **Stale-signal guard.** A manager must not fire on a signal (failed CI / conflicting
   mergeable) whose head SHA predates the last push the arbiter recorded. The arbiter
   exposes `lastActedHeadSha(sessionId)` so a manager can drop a transition whose
   `headSha` matches an already-acted head.
4. Auto-merge consults the arbiter as a cheap precondition: skip a merge while a
   remediation claim is held (auto-merge's own preconditions — green CI, mergeable —
   already make collision rare, so this is belt-and-suspenders, not a rewrite).
5. **Liveness:** the claim must always release — on success, error, exhaustion, defer,
   and the auto-resolve wall-clock timeout. Tie `release()` into the same terminal
   `writeBack` path that owns status transitions so there is exactly one release site
   per automation.

## Key files

- `src/server/orchestrator/auto-fix-manager.ts` — collapses into a base specialization.
- `src/server/orchestrator/auto-conflict-resolve-manager.ts` — collapses into a base specialization.
- `src/server/orchestrator/auto-merge-manager.ts` — route through shared attach-state helper; consult arbiter as a cheap precondition; otherwise unchanged.
- `src/server/orchestrator/auto-remediation-arbiter.ts` (new) — per-session claim/release + await-fresh-signal, owned by the shared base (Workstream C).
- `src/server/orchestrator/session-runner.ts` — `dispatch()` + `AgentDispatchOptions` gain `postTurn` policy + completion signal.
- `src/server/orchestrator/turn-executor.ts` — `executeAgentTurn`: where `postTurn: "none"` actually gates `runCommitAndPr` / `scheduleAutoPush` / `tryDrain`. The real touchpoint for Workstream A.
- `src/server/orchestrator/dispatched-turn.ts` — thin dispatch adapter over `executeAgentTurn`; thread the `postTurn` / `systemTurn` options through.
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
- **Toggle migration** — moving auto-fix to a global persisted setting must default
  off; do not silently re-enable sessions that had the old per-session toggle on.
- **Arbiter liveness** — a claim that never releases wedges every automation for that
  session. Every terminal path (success / error / exhausted / deferred / timeout) must
  release exactly once; cover with a test that asserts the claim is free after each.
- **Await-fresh-signal vs. genuine re-fire** — the suppression must lift once a new head
  SHA is observed, otherwise a legitimately-still-broken PR after a push would never get
  a second automation. Test the full cycle: auto-resolve pushes → new head → CI fails on
  new head → auto-fix is allowed to claim.

## Open questions

All three original open questions are resolved (see Resolved decisions). Remaining
finer-grained calls to make during implementation:

1. **Release-on-push timing for the arbiter** — does the claim release the instant the
   push completes, or only after the poller confirms the new head SHA? Leaning on the
   latter (confirm-new-head) so a fast second automation can't slip in on the old
   signal between push and the next poll. Validate against the auto-resolve force-push
   path, which pushes mid-flow.
2. **Settings UI grouping** — present auto-fix CI and auto-resolve conflicts as two
   switches under a shared "PR automations" settings group? (Cosmetic, but worth doing
   together since both move to global settings.)
