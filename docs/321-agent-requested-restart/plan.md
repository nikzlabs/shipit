---
issue: planning#629
title: Agent-requested container restart — design
description: A shim command records the request; a post-turn step restarts the agent container and wakes the agent with its note.
---

# 321 — Agent-requested container restart: design

Implements [`requirements.md`](./requirements.md).

## Shape

The agent runs `shipit session restart --note "TEXT"` during its turn. That only
**records** the request (req 2 — restarting mid-turn would kill the turn that
asked). When the turn is over, a post-turn step restarts the agent container with
the existing **Restart agent container** code (req 1, req 3), then wakes the agent
on the new container with its note (req 5). No click is involved (req 4).

```
agent turn ──► shipit session restart --note N ──► sessions.pending_restart_note = N
turn ends ──► commit ──► PR/release flows ──► push armed ──► restart step ──► (idle)
restart step, on the current runner only:
   a turn runs or a flow holds the session ──► leave it pending; the next turn's end retries
   otherwise ──► hold new messages ──► restartAgent() carries them ──► wake turn with N ──► held messages run
```

## Pieces

**1. The command.** `shipit session restart --note "TEXT"` in
`agent-shim/shipit-session.ts`, shaped like `continue-after-rebase`: `--note` is
required (req 5), a session id argument is refused (it is always THIS session),
and it relays through the worker (`agent-ops-routes.ts`) to
`POST /api/sessions/:id/restart-after-turn`, marked `containerAccessible` (the
guard already pins the path's id to the caller's own session). The route refuses
with 503 when there is no container manager (local runtime), as `restartAgent`
does, so the agent learns at once that nothing will restart. The command's output
tells the agent that the restart happens after this turn, and to say in its reply
what it restarts and why (req 4).

**2. The pending request is persisted.** A nullable `sessions.pending_restart_note`
column (migration in `database.ts`, accessors on `SessionManager`), so an
orchestrator restart does not lose an accepted request (req 1, req 5). A later
call in the same turn replaces the note; there is one restart. If ShipIt restarts
before the step runs, the request waits for the next turn's end.

**3. The post-turn step.** `runRequestedRestart` runs at the **end of
`runCommitAndPr`** in `turn-executor.ts` (after the push is armed, inside
`postTurnStep`). `runCommitAndPr` is memoized and runs on every terminal path —
streaming result and `done`, non-streaming `done`, adapter error, failed auth
heal, failed quota retry — and it always runs before `signalIdleIfIdle`. So one
hook covers every path, in this order, verified against the code:

- The local commit is done, and `restartAgent` skips its own flush while the
  post-turn lease is held, so nothing is committed twice.
- The PR card and release flow have already emitted on the live runner.
- The auto-push is armed. It runs host-side (`pushToOrigin` through `GitManager`)
  from the session-keyed scheduler, so disposing the runner does not cancel it.
- `idle` has not fired. Its listeners start CI-fix/conflict remediation and read
  the goal through the container; firing them against a container that is about
  to go would race the restart. `idle` on the disposed runner is a no-op, and the
  next turn's end fires it on the new one.

A turn with `postTurn: "none"` (a rebase resolution step) returns from
`runCommitAndPr` early, so the step does not run inside a flow that owns the tree;
the request waits for a later turn.

The step does nothing unless a note is pending, and it acts only when:

- the runner is **the current one** (`runnerRegistry.get(sessionId) === runner`)
  and this turn is still current (`turnIsCurrent()`). A late terminal callback
  from an older turn sees a disposed runner that looks idle; without this check
  it could restart under the turn that made the request.
- no turn is running and no other flow holds the session (`mergeHold`, or a
  `systemTurnInProgress` hold this turn does not own). Otherwise the note stays
  pending and the next turn's end retries. A message queued during the turn has
  already been drained into a running turn by `tryDrain`, which runs before
  `runCommitAndPr`, so it runs on the old container first.

A system turn (a wake, a CI fix, the follow-up turn itself) still holds
`systemTurnInProgress` when `runCommitAndPr` runs, because `finishTurn` releases
it later. The executor passes `ownsSystemHold()` so the step can tell that hold
from another flow's; without it, a restart asked for in a system turn would wait
for a turn that may never come (req 1).

A turn that ended by **Stop** or by an error still ended, so the restart and the
continuation happen (req 2, req 5).

**4. No message is lost during the restart.** The step first clears the note, so a
failed write leaves nothing held. Then, in the same synchronous step as the checks,
it takes a hold on the runner (`takeQueueHold`, `services/recovery.ts`), which also
takes over the ending turn's own hold, so `finishTurn` does not release it. Both
entry points then queue instead of starting a turn: `dispatchOnRunner`, and the
chat send path (`ws-handlers/send-message.ts`), whose final check after its awaits
now includes `systemTurnInProgress` as its first check did. `restartAgent` gains an
opt-in `carryQueue`:

- Just before its forced dispose, which drops the queue, it takes the queued
  entries.
- In the same synchronous step that creates the replacement runner, it holds the
  replacement with a post-turn lease as well, so the idle enforcer cannot reclaim
  it and drop the queue while the container starts (invariant 5). It also takes
  anything that queued on the old runner in the gap while no runner was
  registered: the chat path falls back to the socket's attached runner, which is
  still held.
- It returns the hold (`held`). The wake releases it just before its dispatch
  (`wakeSessionWithTurn` option `releaseHold`), so the wake turn is admitted
  first and the carried messages drain at its end, as they would after any turn.

The **Restart agent container** button does not pass the option and keeps
today's behaviour.

**The step also serves the user.** The stale-container banner's **Restart after
turn** records its own request (`sessions.pending_user_restart`), and this step
restarts for it with the same checks, hold and carried queue, but with no note and
no wake turn. The differences are in
[docs/242-stale-session-container-indicator](../242-stale-session-container-indicator/plan.md#restart-after-turn).

**5. The restart and the wake.** The step settles the ending turn first
(`settle`, which is the executor's `finishTurn`). Otherwise the dispose settles a
finished dispatched turn as interrupted, and the executor settles it a second
time as completed. It then awaits `restartAgent` without the OOM breaker or the
loop detector, so a restart the agent asks for does not reset them as the button
does. It starts `wakeSessionWithTurn` without awaiting it: a system turn built
from `prompts/post-restart-followup.md` (the note, and "do that now, or say it no
longer applies"), activity "Continuing after the restart…". The ending turn's
terminal sequence therefore waits for the container swap, which must finish
before `idle`, but not for the new worker, which can take 30 s.
`wakeSessionWithTurn` keeps a runner whose container is `starting`, and now also
one still `awaitingContainer` (a create in preflight has no container record yet;
disposing it would drop the carried queue). The viewer's "Restarting agent…"
state clears through the health-strip poll (`useContainerHealthPoll`).

**6. Failure.** A throw from `restartAgent`, a replacement that could not be
created (`newContainerState: "missing"`), or a wake that throws parks the note
with `sessionManager.appendPendingAgentNotice` (`[System] The agent container
restart you asked for … did not complete (…)`) and releases the holds the step
still owns, so held messages run. A wake that settles without reaching the agent
(refused, dropped, setup failure — `shouldRepark` from
`services/rebase-followup.ts`) parks the follow-up prompt itself. The next turn
starts with the parked notice. `restartAgent` already shows a failed restart on
the health strip.

## Known limits

These came from the independent review. Each is rare, and each fix would add
machinery that no requirement asks for, so the request waits instead:

- **A request with no later trigger.** When the step finds the session held by a
  merge or another flow, or the turn was a rebase-resolution step
  (`postTurn: "none"`), the request waits for the next turn's end. If no turn
  follows, it waits until the user sends a message.
- **A Stop with no terminal event.** If a stopped streaming process sends neither
  `done` nor a result, the interrupt fallback commits the work
  (`post-interrupt-commit.ts`), but the step does not run until the next turn's
  end.
- **An orchestrator restart during the swap.** The note is cleared when the step
  starts, so a ShipIt restart in the seconds before the wake is dispatched loses
  the follow-up turn.
- **A quota stand-down in the same turn.** The quota continuation can queue a
  second continuation turn behind the restart's.

## Rejected alternatives

- **Call the existing restart endpoint from the agent.** It kills the running
  turn (req 2) and flushes a partial commit.
- **Run the restart from the runner's `idle` event.** It fires last, next to
  remediation and the goal read, which use the container — a race.
- **Restart before queued messages run.** Every drain point would need a gate;
  letting a drained turn finish first needs none.
- **A hook on each terminal path.** Six call sites where one memoized one exists.
- **Keep several notes per request.** Nothing asks for it; a later call replaces
  the note.
- **Emit a final "ready" phase.** The health-strip poll already clears it.
- **A confirmation card.** Req 4 says no click.

## Docs to change

- `src/server/shipit-docs/sessions.md` — the subcommand table.
- `src/server/shipit-docs/environment.md` — "Asking the user for a restart"
  becomes "Restarting your agent container": the agent restarts the agent
  container itself and asks the user only for **Restart all**.
- `src/server/shipit-docs/wiki/sessions.md` — the agent can restart its own agent
  container after its turn.
- `src/server/shipit-docs/wiki/troubleshooting.md` — "Who does what".
- `agent-shim/shipit.ts` — `HELP`.

## Key files

| File | Change |
|---|---|
| `src/server/session/agent-shim/shipit-session.ts`, `shipit.ts` | The command and its help |
| `src/server/session/agent-ops-routes.ts` | Worker relay |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `POST /api/sessions/:id/restart-after-turn` |
| `src/server/shared/database.ts`, `src/server/orchestrator/sessions.ts` | `pending_restart_note` column and accessors |
| `src/server/orchestrator/services/agent-restart-request.ts` | The request, and the step: checks, hold, restart, wake, failure parking |
| `src/server/orchestrator/services/recovery.ts` | `takeQueueHold`, and `restartAgent` option `carryQueue` |
| `src/server/orchestrator/wake-session.ts` | Option `releaseHold`; keep a runner still awaiting its container |
| `src/server/orchestrator/ws-handlers/send-message.ts` | The final admission check includes the system hold |
| `src/server/orchestrator/turn-executor.ts` | Call the step at the end of `runCommitAndPr`, after `armPendingPush` |
| `src/server/orchestrator/session-runner.ts` | The `SystemTurnDeps.runRequestedRestart` seam |
| `src/server/orchestrator/bootstrap-managers.ts`, `runner-registry-factory.ts` | Build the step (it resolves the registry lazily) and wire it into dispatched turns |
| `src/server/orchestrator/route-registry.ts`, `ws-handlers/types.ts`, `ws-handlers/agent-execution.ts` | Wire the same step into interactive turns |
| `src/server/orchestrator/prompts/post-restart-followup.md` | The wake prompt |
