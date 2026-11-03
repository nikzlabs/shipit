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
resume takes effect on the next poll. `rebaseAndResolveCb` (`app-lifecycle.ts`)
reads the pause once more after the manager's runner await and returns
`deferred` (`paused`), which costs no attempt and ends the "Rebasing…" banner the
attempt announced.

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
- `src/server/orchestrator/app-lifecycle.ts` — the pre-flight pause read in `rebaseAndResolveCb`.
- `src/server/orchestrator/api-routes-github.ts` — `POST /pr/auto-resolve-pause`.
- `src/client/stores/session-store.ts` — `setAutoResolveConflictsPaused`.
- `src/client/components/PrStatusControls.tsx` — `AutoResolvePauseToggle`, `useAutoResolvePaused`.
- `src/client/components/PrActionsMenu.tsx` — renders the switch.
- `src/client/components/PrLifecycleCard/phases/OpenPhase.tsx` — hides the failure banner while paused.
- `src/client/hooks/useAttentionInfo.ts` — the pauses in the attention marker.

## Tests

- `auto-conflict-resolve-manager.test.ts` — paused session never fires, resume fires on the next poll; a deferred attempt does not fire on idle once paused.
- `sessions.test.ts` — the flag persists across manager instances.
- `integration_tests/pr-ci-fix.test.ts` — route persists and clears the flag; 404 / 400.
- `PrActionsMenu.test.tsx` — switch hidden without the setting or a remote; toggles this session only; reverts on refusal.
- `PrLifecycleCard.test.tsx` — failure banner hidden while paused.
- `useAttentionInfo.test.ts` — paused sessions flag a conflict / CI failure.
