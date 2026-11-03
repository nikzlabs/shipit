---
issue: planning#716
title: Pause conflict auto-resolve per session — design
description: A per-session pause flag, gated in the shared remediation base, toggled from the PR ⋮ menu.
---

# Pause conflict auto-resolve per session — design

Implements [requirements.md](requirements.md). It reuses the docs/186 CI pause
mechanism (`docs/186-pause-ci-autofix-per-session/plan.md`) one for one; this page
records only what differs.

## How it works

**Storage (req 3).** `sessions.auto_resolve_conflicts_paused`, surfaced as
`SessionInfo.autoResolveConflictsPaused`, set by
`SessionManager.setAutoResolveConflictsPaused`. It rides the existing bootstrap and
`session_list` channels, so no new message type.

**The gate (reqs 4, 5).** `AutoConflictResolveManager` now passes the
`isSessionEnabled` hook to `AutoRemediationManager`, which checks it after the
workspace gate in `runTransition` and `onRunnerIdle`. The poller wires it to
`!sessionManager.get(id)?.autoResolveConflictsPaused`, read at decision time, so a
resume takes effect on the next poll. Both base paths now check the two gates
once more after their awaits (`ensureRunner`, `verifyRunningState`) and before
they claim the attempt, so a pause made while a runner was being created starts
nothing, announces nothing and sets no cooldown. That re-check is in the shared
base, so it closes the same window for the docs/186 CI pause and for either
workspace setting going off.

A resolved signal (the PR merges cleanly again) seen while the gate is off still
deletes the session's state. Before, the gate returned first, so a session that
had exhausted its three attempts, was paused, and saw the conflict clear kept
`exhausted` and never fired for a later conflict on the same head after a resume
(req 5). The fix is in the shared base, so it holds for the CI pause too. A
`running` state is not deleted, since deleting it would let its attempt's result
land on a new episode started after a resume. It gets `pendingReset` instead, the
mechanism user activity already uses: the result writes back, then the budget
resets. And after its awaits, a transition fires only if its state is still the
session's current one, so a resolution polled while a runner was being created
stops the stale attempt (this race existed without a pause, too).

**No withdraw.** The CI pause has to remove a fix turn that waits in the queue or
the hold store. The conflict-resolution turn never waits: `rebase-driver.ts`
dispatches it with `whenBusy: "refuse"` under the flow's own hold. So the pause
route only stores the flag; an attempt already under way finishes (req 5).

**Route.** `POST /api/sessions/:id/pr/auto-resolve-pause { paused }` stores the
flag and re-broadcasts `session_list`.

**UI (reqs 1, 2).** `AutoResolvePauseToggle` (`PrStatusControls.tsx`) in
`PrActionsMenu`, gated on `canAutoMerge && settings.autoResolveConflicts`. On ⇒ runs
for this session, off ⇒ paused. `session-store.setAutoResolveConflictsPaused`
flips the record optimistically and reverts on a failed POST.

While paused, the card hides the "Auto-resolve couldn't finish … Retry" banner,
because Retry goes through the same gate and would do nothing; **Resolve
conflicts** stays, as it does whatever the setting. The attention marker
(`rowAttentionInputs` → `computeAttentionReason`) treats a paused session like one
with the workspace setting off, so a conflicting PR flags the session. The same
input now carries the docs/186 CI pause, which the marker ignored before.

## Key files

- `src/server/shared/database.ts` — column migration.
- `src/server/orchestrator/sessions.ts` — row mapping and setter.
- `src/server/orchestrator/auto-conflict-resolve-manager.ts` — forwards `isSessionEnabled`.
- `src/server/orchestrator/pr-status-poller.ts` — wires the gate to the flag.
- `src/server/orchestrator/auto-remediation-manager.ts` — the gate re-check after the awaits.
- `src/server/orchestrator/api-routes-github.ts` — `POST /pr/auto-resolve-pause`.
- `src/client/stores/session-store.ts` — `setAutoResolveConflictsPaused`.
- `src/client/components/PrStatusControls.tsx` — `AutoResolvePauseToggle`, `useAutoResolvePaused`.
- `src/client/components/PrActionsMenu.tsx` — renders the switch.
- `src/client/components/PrLifecycleCard/phases/OpenPhase.tsx` — hides the failure banner while paused.
- `src/client/hooks/useAttentionInfo.ts` — the pauses in the attention marker.

## Tests

- `auto-conflict-resolve-manager.test.ts` — paused session never fires, resume fires on the next poll; a pause while the runner is made starts nothing and sets no cooldown; a deferred attempt does not fire on idle once paused.
- `sessions.test.ts` — the flag persists across manager instances.
- `integration_tests/pr-ci-fix.test.ts` — route persists and clears the flag; 404 / 400.
- `PrActionsMenu.test.tsx` — switch hidden without the setting or a remote; toggles this session only; reverts on refusal.
- `PrLifecycleCard.test.tsx` — failure banner hidden while paused.
- `useAttentionInfo.test.ts` — paused sessions flag a conflict / CI failure; a CI failure under auto-fix does not hide a paused conflict.
