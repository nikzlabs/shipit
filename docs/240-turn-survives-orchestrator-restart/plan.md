---
issue: planning#259
description: A session whose agent turn is mid-flight when the orchestrator restarts comes back running — the turn is adopted, its events persist, and the post-turn commit/push/PR flow still fires.
---

# Turns survive an orchestrator restart

## The incident

Production, 2026-07-30 ~14:01 UTC. The orchestrator container crashed and was
restarted by its `unless-stopped` policy. Session worker containers are separate
containers with their own lifetime, so they kept running — ten of them, several
with agent turns in flight.

On boot the new orchestrator logged `Rediscovered 10 container(s) from previous
run` and, as each session was opened, reconnected its SSE stream. Every replayed
agent event was then dropped:

```
[sse-drop:<id>] agent_event type=agent_assistant dropped (no _agent)
[sse-drop:<id>] agent_event type=agent_result   dropped (no _agent)
```

Consequences, per affected session:

- `runner.running` was never set, so the UI showed the session as **stopped**
  while the CLI was still working inside the container.
- The turn's transcript tail was never persisted. Worse, the partial rows the
  *previous* orchestrator had written were still `in_progress=1`, so the next
  turn's `replaceInProgress` deleted them — the turn vanished from history
  entirely while its edits sat in the working tree.
- `postTurnCommit` → `scheduleAutoPush` → PR lifecycle card never ran.
- Recovery was manual: type "continue" into every affected session.

## Root cause

`handleSSEEvent` (`container-session-runner.ts`) routes agent events to
`this._agent`, falling back to `this._streamingProxy`. Both are **in-memory
objects that died with the old process**. Container rediscovery rebuilds the
container map and the SSE transport, but nothing rebuilds the agent proxy or its
listeners for a turn that was already running.

The `(no _agent)` drop branch itself is correct — it exists for the docs/140
case, where a genuinely orphaned stale worker process keeps emitting after the
orchestrator finalized its turn. The restart case *pattern-matches* that branch
(no agent object, events arriving) while being its exact opposite: the process
is live and the turn is real. The orchestrator had no way to tell them apart,
because nothing on the wire said "a turn is in flight".

**`running` was not that signal.** The worker's `/agent/status` reported
`running: this.agent !== null` — true for a resident streaming process sitting
*idle between turns*, which under live steering (default on) is the steady
state. Distinguishing "a process occupies the slot" from "a turn is mid-flight"
is the fact the fix turns on.

## The fix

### 1. The worker publishes turn liveness

`AgentController` tracks the turn, not just the process:

| Field | Set | Cleared |
|---|---|---|
| `turnActive` | `/agent/start`; `/agent/message` into an **idle** resident process (how every turn after the first starts under live steering) | `agent_result`; process `done`/`error`; `/agent/kill`; `stop()` |
| `turnStartSseSeq` | the SSE seq at the instant the turn started, captured *before* the adapter can emit | — |
| `runToken` / `agentId` / `streaming` | recorded per spawn | on process exit |

`GET /agent/status` publishes all of it (plus `oldestSseSeq`, the oldest event
still in the replay ring). The shape is `WorkerAgentStatus` in
`shared/types/agent-types.ts` — shared because both layers depend on it. Every
new field is optional on the wire: a container started by an older build runs an
older worker, and a missing `turnActive` means "unknown", which keeps the
pre-fix conservative behavior.

A mid-turn steer (`/agent/message` while `turnActive`) deliberately does **not**
move `turnStartSseSeq` — the anchor must stay at the turn's first event so the
whole turn remains replayable.

### 2. The orchestrator adopts the turn before connecting SSE

`reconcileWorkerTurnBeforeFirstConnect` (formerly
`fastForwardCompletedTurnBeforeFirstConnect`) probes `/agent/status` before the
runner's first SSE connect and now has three outcomes:

- **`turnActive` + no local agent** → **adopt** (below).
- **`turnActive` + a local agent** → leave the cursor alone; a mid-turn viewer
  must still replay the live turn (the docs/237 snapshot path).
- **otherwise** → fast-forward the cursor past the completed turn, as before.
  This branch now also covers a *resident-but-idle* streaming process, which the
  old `running === true` guard conservatively excluded — so the completed-turn
  replay is skipped in more cases, not fewer.

Adoption (`adoptWorkerTurn` → `turn-adoption.ts`):

1. anchor the SSE replay cursor at `turnStartSseSeq`, so the replay covers this
   turn and *not* the previous, already-persisted one;
2. create a `ProxyAgentProcess` carrying the **worker's** `runToken` — a
   freshly-minted token would make `isStaleSpawnEvent` (docs/146) ignore the
   turn's eventual `agent_done` and strand `running=true` forever;
3. run the turn through the same `executeAgentTurn` every other turn uses, in
   `adopt` mode: identical listener + post-turn wiring, minus the spawn (the
   process is already running; re-POSTing `/agent/start` would 409, and a
   `sendUserMessage` would inject a phantom message) and minus the user-row
   persist (the pre-restart orchestrator already wrote it).

From there everything is the normal path: replayed events accumulate into chat
rows, `agent_result` finalizes the turn, and `postTurnCommit` → auto-push → PR
lifecycle card run off it.

The slot must be filled **before** the stream opens or the replay is dropped, so
`ensureWorkerResourcesStarted` now serializes concurrent callers on a single
in-flight promise (`_workerStartInFlight`) — otherwise a viewer attaching at the
same moment as the reattach sweep could connect SSE mid-probe.

### 3. Reattaching without a viewer

A runner is only created lazily, on viewer attach. Left at that, a turn running
in a container nobody opens keeps emitting into a bounded ring buffer that
eventually evicts it, and its commit/push never happens.

`restart-turn-reattach.ts` closes the window at boot: it probes each
rediscovered container and materializes a runner **only** for those reporting a
live turn. Runner creation then runs the identical adopt path
(`resumeInFlightTurn`). Idle sessions are deliberately never *woken* — creating a
runner starts compose stacks and installs, which must not happen for sessions
the user never opened. Wired from `bootstrap-managers.ts` (where both the
container manager and the runner registry are in scope), awaited there before
`buildApp` returns — so before the server listens — with each probe
independently guarded.

Since docs/242 the same sweep also *reclaims* a stale idle worker — destroying
its agent container and not recreating it, so an update frees the memory it was
holding. That never touches an adopted turn: the two branches are exclusive on
`turnActive`, and the reclaim additionally consults the docs/235 liveness fields
the worker now publishes, because a self-woken turn does not set `turnActive`.

### 4. Exactly-once persistence

The pre-restart orchestrator wrote the turn's partial rows as `in_progress=1`
(that is what every tool-result boundary writes). The listener's `agent_result`
handler calls `replaceInProgress`, which **deletes every in-progress row** before
writing the rebuilt turn. So a replayed turn lands in history exactly once no
matter how much of it was already persisted before the crash — no dedup logic
needed, and the guarantee is the same one that already protects an interrupted
turn.

### 5. A turn that ended during the restart keeps its saved rows

Adoption covers a turn that is still running. A turn that *ended* while no
orchestrator listened is not adopted: its events are skipped with the completed
turn, so nothing finalizes the rows the previous orchestrator saved as
`in_progress=1`, and the next turn's `replaceInProgress` deleted them — the same
loss as the incident, by another path. The same holds when the session's worker
is gone (container exited, reclaimed, or never running at boot), and in local
mode, where no agent outlives the process.

Rows are finalized only where a worker says its turn has ended
(`workerReportsNoTurn`: `turnActive === false`, or a legacy worker with no agent
process), or where the session gets a new container. And only rows an earlier
orchestrator process wrote: `ChatHistoryManager.finalizeInheritedInProgress`
does nothing once this process has written the session's in-progress rows.
`replaceInProgress` replaces a session's in-progress rows as a whole, so once a
turn here has written, the old rows are already gone and the in-progress rows are
that turn's. This is what lets each point act while a new turn is already running:

- **The boot sweep** finalizes the sessions whose worker answered that way (on
  the confirming probe too, for a stale worker). It does not touch a session
  whose worker it did not reach: Docker discovery can miss a live container,
  which the orphan check (`adoptRunningContainer`) adopts later, and adoption must
  still replace those rows. In local mode, where no agent outlives the process,
  it finalizes every session. A sweep that throws finalizes nothing.
- **A runner's first connect** (`_doStartWorkerResources`) finalizes when the
  worker says the turn has ended. This covers a worker whose boot probe failed,
  also when a message reaches the session before anyone opens it: the new turn's
  first rows arrive over the event stream, which opens after this step.
- **A runner created for a new container** (`awaitingContainer`, in
  `runner-registry-factory.ts` `onRunnerCreated`) finalizes at once: a new
  container holds no earlier turn, and no turn has run in this runner yet. This
  covers a session whose container is gone. It acts before the new container is
  up; if that container never starts while a live old one that discovery missed
  keeps running, its rows are kept as they were saved, and nothing adopts that
  old turn into this runner later.

The rows keep only what the previous orchestrator saved; the events after that
are still skipped.

## Known limit: a turn longer than the replay buffer

The worker's ring buffer holds 5000 events. A turn that outruns it can only be
replayed from its tail, and its earliest rows are unrecoverable — the adoption
logs `PARTIAL replay — buffer starts at <seq>` when `oldestSseSeq` has passed
`turnStartSseSeq`. This is still a strict improvement: before the fix such a
turn was lost *entirely* (and then deleted from history by the next turn's
`replaceInProgress`). Raising the capacity, or persisting the tail differently,
is the follow-up if this shows up in practice.

`turnStartHeadHash` is also unavailable for an adopted turn (the process that
knew it is gone), so `postTurnCommit` skips the "branch tip moved with a clean
tree" auto-push heuristic and falls back to the normal working-tree
auto-commit — which is what almost every turn needs anyway.

## Key files

| File | Role |
|---|---|
| `src/server/session/agent-controller.ts` | Tracks `turnActive` / `turnStartSseSeq` / spawn metadata; publishes them on `GET /agent/status` |
| `src/server/session/sse-broadcaster.ts` | `oldestSeq` getter (partial-replay detection) |
| `src/server/shared/types/agent-types.ts` | `WorkerAgentStatus` — the shared wire shape |
| `src/server/orchestrator/container-session-runner.ts` | `reconcileWorkerTurnBeforeFirstConnect`, `adoptWorkerTurn`, `resumeInFlightTurn`, serialized worker-resource start; finalizes an ended turn's rows at the first connect |
| `src/server/orchestrator/turn-adoption.ts` | Wires an already-running worker turn into a runner + proxy via `executeAgentTurn` |
| `src/server/orchestrator/turn-executor.ts` | `TurnInput.adopt` — skip env-prep + spawn, keep everything else |
| `src/server/orchestrator/proxy-agent-process.ts` | Optional `runToken` so an adopting proxy inherits the worker's spawn epoch |
| `src/server/orchestrator/restart-turn-reattach.ts` | Boot sweep: probe rediscovered containers, reattach the live ones — and (docs/242) reclaim the stale idle ones; then finalize the rows of turns their worker reports as ended (`workerReportsNoTurn`) |
| `src/server/orchestrator/chat-history.ts` | `sessionsWithInProgressRows`, and `finalizeInheritedInProgress` (only rows an earlier process wrote) |
| `src/server/orchestrator/runner-registry-factory.ts` | Finalizes the rows when a runner is created for a new container |
| `src/server/orchestrator/bootstrap-managers.ts` | Fires the sweep after the runner registry exists |
| `src/server/orchestrator/integration_tests/restart-turn-adoption.test.ts` | Real worker + fresh runner: adoption, exactly-once persistence, post-turn flow, run-token correlation, and the two must-not-adopt cases; a turn that ended during the restart keeps its rows past the next turn (through the boot sweep, and through the first connect, also when a message arrives first), and a live one is saved once |
| `src/server/orchestrator/restart-turn-reattach.test.ts` | Sweep: adopts live turns, never wakes idle/standby/archived sessions, survives one dead worker; finalizes only the rows of turns their worker reports as ended |
| `src/server/orchestrator/runner-registry-factory.test.ts` | A runner for a new container finalizes the rows; one that reconnects does not |
