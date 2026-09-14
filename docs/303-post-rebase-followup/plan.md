---
title: Post-rebase follow-up — design
description: An agent-armed note carried across an orchestrator-driven rebase, played back as a dispatched turn once the rebase concludes.
---

# Post-rebase follow-up — design

Implements [requirements.md](./requirements.md).

## Shape

One sentence: **while the agent is resolving conflicts it can hand ShipIt a note,
and ShipIt gives that note back as a turn once the rebase concludes.**

```
ShipIt starts the rebase → conflicts
  → conflict-resolution turn (the agent edits the files)
       agent runs: shipit session continue-after-rebase --note "re-run codegen, update snapshots"
  → ShipIt stages, continues, more rounds if needed
  → rebase concludes → force-push → branch-synced card
  → ShipIt dispatches a turn: outcome + the agent's own notes
```

No note armed ⇒ nothing extra runs, exactly as today (req 4).

## The arm

**Scoped to one rebase attempt.** `runRebaseFlow` opens a window before its first
conflict-resolution turn and closes it when the attempt ends.

**The window carries an attempt id, and closing is by id.** Closing by session id
alone is not enough. `runAutoResolveAttempt` races the flow against a deadline
(`rebase-driver.ts:743`) and **does not cancel the flow** when the deadline wins, so
a timed-out flow can settle long afterwards — after the next attempt has opened its
own window. Closing by id makes a late straggler harmless.

**The timeout path must close the window explicitly.** The claim that the flow's
`finally` closes it "by construction" is false: `runRebaseResolutionTurn` settles
only through `onTurnComplete` (`rebase-driver.ts:590`), so an agent that hangs and
ignores `kill()` leaves that promise pending for ever and the `finally` never runs.
The existing timeout test uses exactly such an agent
(`rebase-driver.test.ts:1261`). The timeout handler already clears
`systemTurnInProgress` by hand for the same reason (`rebase-driver.ts:703`); the
window is cleared in the same place. Without this, req 3 fails: a note armed in a
timed-out attempt would wake on a later, unrelated rebase.

Stored in a new `services/rebase-followup.ts` as a process-lived `Map` keyed by
session id — **not** on the runner, per the CLAUDE.md invariant that post-turn work
never hangs off a runner that `dispose()` can take away mid-flight
(`services/auto-push-scheduler.ts` is the precedent). The Map is a registry, not a
lifetime guarantee; see *Ownership* below for the part it does not solve.

A rebase can take several conflict rounds (`MAX_REBASE_ITERATIONS`), so **notes
append across rounds**. Replacing would silently drop round 1's note when round 2
conflicts in a different file. De-duplicating identical text is a one-line
convenience, not a correctness guard — it prevents a repeated instruction in the
prompt and nothing else.

Arming with no window open is refused by the CLI with the reason: ShipIt only
carries a note across a rebase it is driving.

## The command

`shipit session continue-after-rebase --note "<what to do once the rebase lands>"`

- Handler in `agent-shim/shipit-session.ts`, **registered in `SESSION_HANDLERS`**
  (`agent-shim/shipit.ts:480`) — a handler alone does not expose the command.
- `POST /agent-ops/session/continue-after-rebase` relays to
  `POST /api/sessions/:sessionId/continue-after-rebase`, following
  `notify-on-merge --self`.
- `--note` is required, and a non-empty note is validated again at the server
  boundary. Without a note there is nothing to play back, and the outcome alone is
  already delivered by the existing sync card.
- Named for **rebase**, not sync, because the agent's own conflict prompt says
  "Rebasing onto `main`". The user-facing button stays "Sync".

## Discoverability — the load-bearing half

An armable command the agent never hears about is never used. The disclosure point
is `buildRebaseConflictPrompt` (`rebase-driver.ts:59`), which is composed per rebase
and is the one text the agent is guaranteed to read at the moment the decision is
live. Add one paragraph: if finishing this properly needs work *after* the rebase
concludes, arm it now with this command, because this turn ends before the rebase
does.

`src/server/shipit-docs/github.md` gets the same command for reference, but the
prompt is what makes it work.

## Delivery

**Only `conflicts_resolved` can carry notes.** `up_to_date` returns at
`rebase-driver.ts:358` and `rebased` returns at `rebase-driver.ts:389`, both before
the conflict loop that opens the window. A `conflicts_resolved` whose force-push
failed is still eligible: the local rebase concluded, which is what the agent's note
is about.

The success paths `return` from inside the `try`, so delivery cannot be a statement
written after the `finally`. Capture the outcome and the notes at the return point,
close the window there, and dispatch from a wrapper around `runRebaseFlow` so both
call sites get identical behaviour.

Dispatch after the owning path's final cleanup, not merely after the flow's
`finally`. On the idle path `runAutoResolveAttempt` does a second LFS restoration
and its own `drainQueue` *after* the flow returns (`rebase-driver.ts:747`). LFS
restoration writes files in place, so a follow-up turn started before it would be
editing a tree still being rewritten.

- Compose from `prompts/post-rebase-followup.md` (prompt text as data, per the
  repo's prompt-cache contract): base branch, before/after SHAs, whether it was
  force-pushed, the tree-was-rewritten warning already in
  `buildBranchSyncAgentNotice`, then the agent's notes verbatim.
- `runner.dispatch(prepareDispatch({ ..., systemTurn: true }), { whenBusy: "queue" })`.
  **Not `postTurn: "none"`.** The resolution turn uses it because the rebase owns
  the commits, but the follow-up turn writes ordinary edits that must be committed
  and pushed (`turn-executor.ts:614`).
- Queueing rather than refusing means a user message typed *during* the rebase is
  answered first and the follow-up still runs. Note the flow's `finally` releases at
  most **one** queued entry and only when `runner.running` is false
  (`rebase-driver.ts:491`, `queue-drain.ts:26`) — it does not drain the queue, so
  the follow-up must be admitted through the queue like any other turn rather than
  assume an empty one.

### `pendingAgentNotice` needs no special handling

The first design consumed it at dispatch time to avoid a duplicate warning. **Cut.**
Any dispatched turn whose `postTurn` is not `"none"` already consumes it
(`dispatched-turn.ts:194`), and consuming it early would steal the rewrite warning
from a queued user turn that has not yet reached its own consumption point. Whichever
turn runs first gets the notice; there is no duplication to prevent.

### When delivery fails

`dispatch()` returns a `TurnHandle` whose `settled` promise **resolves** with an
outcome and never rejects (`turn-settlement.ts:53`), so a synchronous `try/catch`
would miss a setup failure that arrives later. Observe the handle instead.

On `refused`, `dropped` or `errored` **before the prompt reached the agent**, re-park
the notes with `appendPendingAgentNotice` — **not** `setPendingAgentNotice`, which
replaces and would clobber a newer branch notice (`sessions.ts:379`). The work then
waits for the user's next message: today's behaviour, and explicitly **not**
fulfilment of req 1 — it is damage limitation on a path that should be rare.

Do **not** re-park after `interrupted`. A user who stops a delivered follow-up turn
has decided against it.

Observing the handle must not hold the rebase attempt open. Otherwise the
auto-resolve deadline ends up supervising a completely unrelated turn.

## Ownership — a gap this feature depends on

`agentBusy` covers `_isRunning`, background tasks, sub-agent spawns, the post-turn
hold and installs (`container-session-runner.ts:259`), and `dispose()` checks the
same set. **`systemTurnInProgress` is in neither.** The rebase takes a post-turn
lease only around LFS restoration (`rebase-driver.ts:166`), so between the last
resolution turn and the force-push the runner reads as idle and a non-forced
`dispose()` is free to take it — an existing gap, not one this feature creates, but
one the delivery guarantee would sit on, and most exposed on the idle path where no
viewer is attached.

**Tracked and fixed separately as planning#556**, since it stands on its own. This
feature depends on that fix: a follow-up turn dispatched at the end of a publication
segment whose runner can vanish has no delivery guarantee. Implement planning#556
first, or at least confirm it landed.

## No card for the arm

docs/239-self-merge-wake gives arming a cancellable card because its watch can sit
open for days. This arm lives for one rebase and is consumed automatically, so a
card would be noise. The command's own output confirms the arm, and the follow-up
turn is ordinary transcript content.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/rebase-followup.ts` | New. Attempt-keyed window, note list, prompt composition, dispatch, handle observation. |
| `src/server/orchestrator/services/rebase-driver.ts` | Open/close the window by attempt id; close it on the timeout path; extend `buildRebaseConflictPrompt`; deliver from a wrapper after each path's final cleanup. |
| `src/server/orchestrator/prompts/post-rebase-followup.md` | New. Follow-up turn text. |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `POST /api/sessions/:sessionId/continue-after-rebase`, non-empty note validated. |
| `src/server/session/agent-ops-routes.ts` | Relay route. |
| `src/server/session/agent-shim/shipit-session.ts` | The CLI handler. |
| `src/server/session/agent-shim/shipit.ts` | Register the subcommand in `SESSION_HANDLERS` and its help. |
| `src/server/shipit-docs/github.md` | Agent-facing reference. |

## Tests

- `rebase-followup.test.ts` — notes append across rounds; arming with no window
  refused; an empty note refused; closing by a stale attempt id leaves a newer
  window intact.
- `rebase-driver.test.ts` — an arm survives multiple conflict rounds; **an attempt
  that times out with a hanging agent leaves no window** (req 3, the case the first
  design got wrong); a `rebased` or `up_to_date` outcome never carries notes.
- Integration — a concluded rebase with an arm dispatches a turn carrying the note;
  without an arm no turn is dispatched; a turn that settles `errored` re-parks the
  notes via append without clobbering an existing notice; a turn the user interrupts
  does not re-park; a queued user turn still receives the rewrite warning.
- Each guard proved red on its own before the fix lands.

## Review

Reviewed cold by ShipIt's configured reviewer (Codex) before implementation, run
`a2901792-450e-43b0-87e9-271e3a4b2d03`. Every finding folded in above was verified
against the code first. The reviewer's own recommended cuts — the unconditional
early notice consumption, and de-duplication as a load-bearing guard — are taken.
