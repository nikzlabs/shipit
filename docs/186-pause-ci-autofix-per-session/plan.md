---
issue: planning#641
description: Per-session pause for the auto-fix-CI loop, toggled from the PR card overflow menu.
---

# Pause CI auto-fixing per session

## What this is

The global **Auto-fix CI** setting (docs/169, `credentialStore.autoFixCi`) is the
master on/off for the PR poller's auto-fix loop: when a tracked PR's checks go to
FAILURE while the agent is idle, the loop fetches the failing logs and dispatches
a fix turn. It is account-wide — on for every session or off for every session.

docs/186 adds a **per-session pause** on top of that global switch. While a
session is paused, the auto-fix loop is suppressed for *that session only*, even
with the global setting on. This is the override for "I'm hand-fixing a flaky
check / debugging CI myself and don't want the agent racing me," without forcing
the user to disable auto-fix everywhere.

The pause is **not** a second on/off switch. The global setting still governs;
the per-session flag can only *subtract* from it. When the global setting is off,
the pause toggle isn't even shown (pausing an already-idle loop is meaningless).

## How it works

**Storage.** The flag lives on the session row — `sessions.auto_fix_ci_paused`
(migration in `database.ts`), surfaced as `SessionInfo.autoFixCiPaused`. Persisted
so a pause survives an orchestrator restart (unlike the in-memory auto-merge
toggle). Getter/setter: `SessionManager.setAutoFixCiPaused`.

**The gate.** The decision lives in the shared remediation base
(`AutoRemediationManager`), which already reads `isGlobalEnabled()` at decision
time in both `runTransition` (the poll path) and `onRunnerIdle` (the
runner-just-went-idle re-fire path). docs/186 adds an optional
`isSessionEnabled(sessionId)` config hook checked right after the global gate in
both places — return false ⇒ suppress for that session. Default-absent means
"always enabled," so the conflict-resolve automation (which has no per-session
override) is unaffected. `AutoFixManager` wires the hook to
`!sessionManager.get(id)?.autoFixCiPaused`, read at decision time so a resume
takes effect on the next poll with no per-session fan-out.

Note the gate sits *after* the signal is cached (base step 2), so a resume's
first poll has the right CI baseline — mirroring how the global re-enable works.

**An attempt already in flight.** Pausing does not kill a fix turn that has
started; it finishes. A fix turn that has *not* started is removed: the dispatch
can wait in the runner's queue (behind a user turn, or behind resident background
work a system turn would destroy) or in the saved hold behind a question
(docs/322), and either way the card read "Auto-fixing" while nothing ran, and the
turn ran later despite the pause.

So the automatic fix dispatch carries `ciAutoFix: true` (`autoFixDispatch` in
`services/github-ci-fix.ts`; the manual **Fix CI** does not), and the field rides
every place an entry can wait: the queue, the pre-turn compaction re-queue, and the
hold store, which serializes the whole entry. On pause the route calls
`PrStatusPoller.withdrawAutoFix`, which runs `withdrawWaitingTurns`
(`queue-drain.ts`) against the session's *current* runner from the registry and
the hold store: every tagged entry is removed and settled `dropped`, so an attempt
in flight ends as a no-op (`deferred`, budget untouched). An entry that already
started is in neither place, so it is left alone. `fetchAndFixCb` also reads the
pause just before it dispatches, which covers a pause during the log fetch.

Why tag-and-sweep, not a per-attempt cancel handle: a held entry outlives both its
runner (a reclaimed runner's held turns are restored onto the replacement) and the
process (the row survives a restart; the manager's in-memory state does not), so
only a sweep of where the entry *is now* reaches it. The one window this leaves —
the `shouldCompactBeforeTurn` await in `dispatched-turn.ts`, where the entry is
briefly in neither place before a compaction re-queues it — is not reachable for
a fix turn: that compaction runs only once the session's PR has merged, and
auto-fix fires only on an open one.

While a started fix turn finishes, the card and the PR panel read "Auto-fix
paused — the current fix turn will finish" instead of the attempt counter, and a
paused session with failing checks shows the **Fix CI** button, as when the
workspace setting is off.

**Route.** `POST /api/sessions/:id/pr/auto-fix-pause { paused }` sets the flag and
re-broadcasts `session_list` over SSE so every tab's PR menu reconciles and a
reload reflects the change (the flag is on the session record, delivered via the
existing bootstrap + `session_list` channels — no new SSE message type).

**UI.** `AutoFixPauseToggle` (in `PrStatusControls.tsx`) is a `ToggleSwitch` row
rendered in the PR overflow menu (`PrActionsMenu`), gated on
`canAutoMerge && settings.autoFixCi` (has a remote + global setting on). The
switch shows the *active* (not-paused) state: on ⇒ auto-fix runs for this
session, off ⇒ paused. Toggling calls `useSessionStore.setAutoFixCiPaused`, which
optimistically flips the session record, POSTs, and reverts on failure.

## Key files

- `src/server/shared/database.ts` — `auto_fix_ci_paused` column migration.
- `src/server/shared/types/domain-types.ts` — `SessionInfo.autoFixCiPaused`.
- `src/server/orchestrator/sessions.ts` — `SessionRow`, `fromRow`, `setAutoFixCiPaused`.
- `src/server/orchestrator/auto-remediation-manager.ts` — `isSessionEnabled` config hook + gate in `runTransition` / `onRunnerIdle`.
- `src/server/orchestrator/auto-fix-manager.ts` — passes the per-session gate to the base.
- `src/server/orchestrator/pr-status-poller.ts` — wires the gate to the session flag.
- `src/server/orchestrator/api-routes-github.ts` — `POST /pr/auto-fix-pause`; a pause withdraws the waiting fix turn (`PrStatusPoller.withdrawAutoFix`).
- `src/server/orchestrator/services/github-ci-fix.ts` — `autoFixDispatch`, the tagged automatic fix turn.
- `src/server/orchestrator/app-lifecycle.ts` — `fetchAndFixCb` reads the pause before it dispatches.
- `src/server/orchestrator/queue-drain.ts` — `withdrawWaitingTurns`.
- `src/client/stores/session-store.ts` — `setAutoFixCiPaused` optimistic action.
- `src/client/components/PrStatusControls.tsx` — `AutoFixPauseToggle`.
- `src/client/components/PrActionsMenu.tsx` — renders the toggle (gated on global setting).

## Tests

- `auto-fix-manager.test.ts` — paused session never fires; resuming re-enables; a withdrawn fix turn ends the attempt uncounted.
- `queue-drain.test.ts` — `withdrawWaitingTurns` removes queued and held matches, settles each once, works with no runner; `ciAutoFix` survives the queue round-trip.
- `PrLifecycleCard.test.tsx` — paused label while a fix turn finishes; Fix CI offered while paused.
- `sessions.test.ts` — `autoFixCiPaused` round-trips and persists across instances.
- `integration_tests/pr-ci-fix.test.ts` — route persists/clears the flag, 404/400 validation; a pause removes a saved automatic fix turn and keeps a manual one.

## Why not a per-session on/off (vs. pause)

docs/169 deliberately removed the old per-session auto-fix *toggle* in favor of a
single global setting (the per-session map was lost-on-restart and drifted from
the conflict automation). docs/186 does not reintroduce that: the global setting
remains the single source of "is auto-fix a thing I want." The pause is a
narrower, subtractive override — it can only turn the loop *off* for one session,
never on independently — so it composes with the global switch instead of
competing with it.
