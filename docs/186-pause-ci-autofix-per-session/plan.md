---
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
Pausing does not kill an in-flight fix turn; it only blocks new fires.

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
- `src/server/orchestrator/api-routes-github.ts` — `POST /pr/auto-fix-pause`.
- `src/client/stores/session-store.ts` — `setAutoFixCiPaused` optimistic action.
- `src/client/components/PrStatusControls.tsx` — `AutoFixPauseToggle`.
- `src/client/components/PrActionsMenu.tsx` — renders the toggle (gated on global setting).

## Tests

- `auto-fix-manager.test.ts` — paused session never fires; resuming re-enables.
- `sessions.test.ts` — `autoFixCiPaused` round-trips and persists across instances.
- `integration_tests/pr-ci-fix.test.ts` — route persists/clears the flag, 404/400 validation.

## Why not a per-session on/off (vs. pause)

docs/169 deliberately removed the old per-session auto-fix *toggle* in favor of a
single global setting (the per-session map was lost-on-restart and drifted from
the conflict automation). docs/186 does not reintroduce that: the global setting
remains the single source of "is auto-fix a thing I want." The pause is a
narrower, subtractive override — it can only turn the loop *off* for one session,
never on independently — so it composes with the global switch instead of
competing with it.
