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
  → rebase concludes, branch-synced card, force-push
  → ShipIt dispatches a turn: outcome + the agent's own notes
```

No note armed ⇒ nothing extra runs, exactly as today (req 4).

## The arm

**Scoped to the rebase in flight, not persisted.** `runRebaseFlow` opens a window
before its first conflict-resolution turn and closes it in the `finally`. That makes
req 3 true by construction: an abort, a timeout, or a refusal closes the window with
the notes unconsumed, and there is no stale arm with a lifetime to invent. The
auto-resolver's next attempt gives the agent a fresh resolution turn, so it can arm
again.

Stored in a new `services/rebase-followup.ts` as a process-lived `Map` keyed by
session id — **not** on the runner, per the CLAUDE.md invariant that post-turn work
never hangs off a runner that `dispose()` can take away mid-flight
(`services/auto-push-scheduler.ts` is the precedent).

A rebase can take several conflict rounds (`MAX_REBASE_ITERATIONS`), so **notes
append across rounds**, de-duplicated on identical text. Replacing would silently
drop round 1's note when round 2 conflicts in a different file.

Arming with no window open is refused by the CLI with the reason: ShipIt only
carries a note across a rebase it is driving.

## The command

`shipit session continue-after-rebase --note "<what to do once the rebase lands>"`

- Session-worker CLI in `agent-shim/shipit-session.ts`, following
  `notify-on-merge --self`: parse, `POST /agent-ops/session/continue-after-rebase`,
  relay to `POST /api/sessions/:sessionId/continue-after-rebase`.
- `--note` is required. Without it there is nothing to play back, and the outcome
  alone is already delivered by the existing sync card.
- Named for **rebase**, not sync, because the agent's own conflict prompt says
  "Rebasing onto `main`". The user-facing button stays "Sync".

## Discoverability — the load-bearing half

An armable command the agent never hears about is never used. The disclosure point
is `buildRebaseConflictPrompt` (`services/rebase-driver.ts:59`), which is composed
per rebase and is the one text the agent is guaranteed to read at the moment the
decision is live. Add one paragraph: if finishing this properly needs work *after*
the rebase concludes, arm it now with this command, because this turn ends before
the rebase does.

`src/server/shipit-docs/github.md` gets the same command for reference, but the
prompt is what makes it work.

## Delivery

On `rebased` or `conflicts_resolved`, after the flow's `finally` has restored LFS,
released `systemTurnInProgress` and drained the queue:

- Compose from `prompts/post-rebase-followup.md` (prompt text as data, per the
  repo's prompt-cache contract): base branch, before/after SHAs, whether it was
  force-pushed, the tree-was-rewritten warning already in
  `buildBranchSyncAgentNotice`, then the agent's notes verbatim.
- `runner.dispatch(prepareDispatch({ ..., systemTurn: true }), { whenBusy: "queue" })`.
  Queueing rather than refusing means a user message the user typed *during* the
  rebase is answered first and the follow-up still runs; the alternative — skip the
  dispatch and attach the notes to the queued turn instead — was rejected as two
  code paths for one behaviour.
- **Consume `pendingAgentNotice` when dispatching.** The manual-sync path already
  sets it with the same rewrite warning; leaving it would repeat itself on whatever
  turn comes next.
- **If the dispatch fails, fall back to `setPendingAgentNotice` carrying the notes.**
  The work then waits for the user's next message — today's behaviour — instead of
  being lost.

`up_to_date` cannot have an arm: no conflict turn ran.

The idle auto-resolve path gets this for free, because it delivers through
`runRebaseFlow` (req 5). Consequence, accepted at requirements time: a session the
user walked away from can start an unattended turn, which also keeps its container
off the idle-reclaim list while that turn runs.

## No card for the arm

docs/239-self-merge-wake gives arming a cancellable card because its watch can sit
open for days. This arm lives for one rebase — minutes — and is consumed
automatically, so a card would be noise. The follow-up turn itself is ordinary
transcript content, appearing right after the branch-synced card that explains it.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/rebase-followup.ts` | New. Arm window, note list, prompt composition, dispatch. |
| `src/server/orchestrator/services/rebase-driver.ts` | Open/close the window; call the dispatch after the `finally`; extend `buildRebaseConflictPrompt`. |
| `src/server/orchestrator/prompts/post-rebase-followup.md` | New. Follow-up turn text. |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `POST /api/sessions/:sessionId/continue-after-rebase`. |
| `src/server/session/agent-ops-routes.ts` | Relay route. |
| `src/server/session/agent-shim/shipit-session.ts` | The CLI command. |
| `src/server/shipit-docs/github.md` | Agent-facing reference. |

## Tests

- `rebase-followup.test.ts` — notes append across rounds, identical text
  de-duplicated, arming with no window refused, window close drops the notes.
- `rebase-driver.test.ts` — arm survives multiple conflict rounds; an abort and a
  timeout both leave nothing to dispatch (req 3).
- Integration — a concluded rebase with an arm dispatches a turn whose text carries
  the note; without an arm, no turn is dispatched; a failed dispatch leaves the note
  in `pendingAgentNotice`.
- Each guard proved red on its own before the fix lands.
