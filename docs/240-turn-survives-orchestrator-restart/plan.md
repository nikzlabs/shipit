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
| `turnActive` | `/agent/start`; `/agent/message` into an **idle** resident process (how every turn after the first starts under live steering); a turn a resident streaming CLI starts on its own (§6) | `agent_result`; process `done`/`error`; `/agent/kill`; `stop()` |
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

For the same reason the stream does not open until the status has been read
(planning#665, §7). A runner for a container still being created reads nothing:
that container holds no earlier turn.

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
the worker publishes. A worker older than planning#639 needs them for a
self-woken turn, which it reports with `selfWakeActive` and not `turnActive` (§6).

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

### 6. A turn the CLI starts on its own (planning#639)

A resident streaming CLI starts turns nobody sent it: on a task notification
(`agent_self_wake`, docs/235-agent-self-wake-liveness) and by answering a late
steer after the turn's result (docs/140-live-steering Phase 6.11). Without a
restart, `adoptCliStartedTurn` follows them — but that is a closure on a proxy
`executeAgentTurn` wired, so it died with the old orchestrator. Until
planning#639 the worker did not count such a turn as a turn either, so neither
adoption point saw it: every event was dropped `(no _agent)`, the session showed
idle, nothing was saved or committed, and the next message replaced the CLI
process mid-turn. An update is such a restart, and it keeps the session
containers (`deployment/vps/deploy.sh`).

**The worker counts it.** `startsOwnTurn` (`agent-controller.ts`) begins a turn
at the two events, *before* it broadcasts the event, so `turnStartSseSeq` sits
just ahead of it. The second event is the executor's own `adoptsCliStartedTurns`
test — a backend that `startsOwnTurns` — and a one-shot process counts for
neither: it exits at its turn's end. The status says which kind of turn it is:
`ownTurn` is present while such a turn runs, and is `"unheard"` until an
orchestrator stream has been open during it.

From there, one path per moment the turn can start:

- **In flight when the orchestrator starts.** `turnActive` is true, so the boot
  sweep and a first connect adopt it like any turn (§2–§3), replaying from its
  first event, and the stale reclaim never sees it as idle. A turn the
  reclaim's confirming probe finds is adopted too: the server is not listening
  yet, so the worker's report (below) found nobody.
- **Later, on a connected runner with no agent.** The first connect remembers
  the streaming process the worker already held (`_unfollowedResident`: its run
  token and agent). An event from that process that starts a turn is adopted
  before it is routed (`adoptOwnTurnAt`): adoption installs the agent, marks
  the session running and wires its listeners before its first await, so the
  event already finds the agent that follows it, and neither a message nor a
  reclaim can get in first. Nothing is asked of the worker and nothing is
  replayed, so a whole turn that arrives in one burst — after a stream gap, say
  — is still followed, and no other event type is delivered twice. The run
  token is what keeps the docs/140 case intact: a process the runner replaced
  or killed is forgotten, and its late output stays dropped.
- **Later, in a session nobody has open.** Nothing listens to such a worker.
  When the turn starts unheard, the worker tells the orchestrator (`POST
  /api/sessions/:id/agent/own-turn`, container-accessible). `followReportedTurn`
  asks the worker's status first and gives the session its runner only for a
  turn in flight — the agent can call the route too, and a runner starts the
  session's Compose services. That runner's first connect adopts as above. The
  sweep itself still wakes nothing (§3): a runner made at boot for a session
  with an outstanding background task would restart those services under the
  task that uses them (`setupServiceManager` → `killStaleContainers`).

**Rows.** §4's exactly-once rule assumes the saved in-progress rows are the
adopted turn's. An unheard turn has none: whatever is saved belongs to the turn
before it, which ended with no orchestrator listening. So `adoptWorkerTurn`
finalizes those rows first (`finalizeInheritedInProgress`), or the replay's
first write would delete them. The adopting runner's stream then makes the turn
heard, so a second restart inside the same turn keeps §4: the rows are the
turn's own partial ones, and the replay replaces them.

**New use.** An adopted turn of this kind is new use of the session (`track`,
docs/316-done-sessions-return-memory req 5) where no orchestrator counted its
start: on a connected runner, which adopts at the start, and for an unheard
turn. A heard one was counted when it began. `ownTurn` is the provenance and
`selfWakeActive` is not: a task notification inside a turn that was sent sets
that flag too.

**Holds.** Adoption takes and releases no system hold — `executeAgentTurn`
leaves `systemTurnInProgress` alone in `adopt` mode — so a rebase or a recovery
that holds the queue keeps it, as with `adoptCliStartedTurn`. And a turn of the
CLI's own is stopped at once while the agent waits for the user's answer
(`stopOwnTurnWhileAwaitingAnswer`, docs/322-question-holds-automatic-turns req 7),
on either path.

**Older workers.** A container outlives the update that ships this, and its
worker reports none of the above. The connected-runner path needs nothing from
the worker, so it follows both kinds of turn there too. The other two do not:
on an older worker such a turn stays unfollowed until the session is opened,
and is then followed from its next event that can start a turn.

**Limits.** A turn that starts and ends while no orchestrator runs is still
lost (§5 keeps what was saved; nothing commits it). The worker reports once and
does not retry, and a turn that ends before the report's status request reaches
the worker is not adopted. A message that reaches a brand-new
runner before its first connect has adopted still replaces the process, as it
does for any turn the sweep could not probe. Heard is decided by an open
stream, so an orchestrator that dies between a turn's result and the next
turn's first event leaves the earlier turn's rows to be replaced. And a runner
made after a restart does not know the task list the old process held
(docs/235), so the session shows no background-work marker until the turn starts.

### 7. A status read that fails does not leave a turn unfollowed (planning#665)

Every path above decides on one read of the worker's status: the sweep's probe
(§3), the first connect (§2), the worker's report (§6). Until planning#665 a
failed read ended the attempt, and nothing asked again. A sent turn that
continued across a restart then had either no runner (the sweep's probe
failed) or a runner that did not follow it (the first connect's read failed:
the stream opened from the start of the replay buffer, and every event of the
turn was dropped `(no _agent)`). Both looked idle: no transcript, no commit, and
the idle reclaim was free to dispose the second. And every container route that
needs a runner refused the turn's own calls with "Session is not active" —
`shipit agent run` among them — until a message from outside made a runner. The
own-turn report answered `following=false` for a runner that existed and did
not follow.

Each read is now followed by another attempt, and every attempt ends in the
adoption of §2, with its replay from the turn's first event:

- **The first connect waits for the status.** When the read fails, the stream
  does not open: an open stream would replay the turn with no agent to follow
  it. The runner tries the whole first connect again on its own (after 0.5 s,
  1 s, 2 s, 5 s, then every 10 s), and at once when something needs it — a
  viewer, a message, the sweep, the worker's report, a container call. While
  it waits:
  - it reads as busy for up to two minutes (a hold, as for post-turn work), so
    the idle reclaim does not destroy a container whose turn may be live;
  - `workerStreamDownSince` counts from the first failed read, so the
    orphan-runner check still reports a worker that stays unreachable;
  - a message it is sent still starts its turn, and the replay keeps that
    turn's events when the stream opens (the cursor skips the completed turns
    only until this runner has posted a start).

  A reading that comes back after the runner was disposed, or after it killed
  the worker's process, adopts nothing: that reading may describe the killed
  process, so it is read again.
- **The sweep tries again later** (after 2 s, 10 s, 30 s, 90 s; through
  `followReportedTurn`) for a session whose probe failed. That session has no
  runner, so nothing else would ask its worker. This runs after the server
  listens, so it does not delay boot.
- **A call from the session's own container** gets its runner through
  `runnerForContainerCall`. With no runner, it asks the worker, and a turn in
  flight gets a runner whose first connect adopts it. A runner that waits for
  the status reads it at once. Any other runner is returned as it is, so a
  call never waits for a stream to reconnect. The worker's status decides, as
  for the worker's report, so a call from an idle session still makes no
  runner and starts no Compose services. The call waits at most 15 s for the
  follow. Every container route that refused with "Session is not active" uses
  it: `shipit agent run`, the status card, propose actions, bug report,
  propose session message, propose repo session, and the issue writes.

A first connect that waited on a stream which failed before it opened used to
wait for good: a reconnect replaced the promise it awaited
(`SseConnectionManager.connect`). The promise now carries over, so the sweep,
the report and a container call return once the stream opens.

`followReportedTurn` logs why it answers false, and the worker logs the answer
to its report, so the next case of a turn that nothing follows names the reason.

Adopting on the open stream instead, after a first connect without the status,
was tried and rejected: the stream drops the turn's events while the status
read is in flight (its `agent_result` among them, which left the session
running for good), a slow read could adopt a process that was killed in the
meantime, and the saved rows it had to keep were saved a second time by the
adoption after a further restart.

**Limits.** While a runner waits for the status it gets no events — terminal
output, install progress, preview ports — so a viewer sees nothing live until
the read succeeds. After two minutes of waiting the hold ends and the idle
reclaim may take the runner; so it may a session that has no runner because the
sweep's probe failed, until a later try gives it one. A turn that ends while
the status cannot be read is not adopted (§5 keeps its saved rows). A message
that reaches a waiting runner while the worker's turn is live still replaces
that process, as in §6. A worker that answers no status read for the whole
time is not followed at all. A turn on a worker older than planning#639 that
the CLI started on its own still reports `turnActive: false`, so no attempt
finds it (§6, "Older workers").

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
| `src/server/session/agent-controller.ts` | Tracks `turnActive` / `turnStartSseSeq` / spawn metadata; publishes them on `GET /agent/status`; `startsOwnTurn` counts a CLI-started turn and `ownTurn` marks it (§6) |
| `src/server/session/session-worker.ts` | `reportUnheardTurn` — tells the orchestrator about a turn that started with no stream open; the stream route makes a turn heard (§6) |
| `src/server/orchestrator/api-routes-agent.ts` | `POST /api/sessions/:id/agent/own-turn`, the receiving end of that report |
| `src/server/session/sse-broadcaster.ts` | `oldestSeq` getter (partial-replay detection) |
| `src/server/shared/types/agent-types.ts` | `WorkerAgentStatus` — the shared wire shape |
| `src/server/orchestrator/container-session-runner.ts` | `reconcileWorkerTurnBeforeFirstConnect`, `adoptWorkerTurn`, `resumeInFlightTurn`, serialized worker-resource start; finalizes an ended turn's rows at the first connect; `_unfollowedResident` / `adoptOwnTurnAt` for a turn that starts on a connected runner (§6); `retryFirstConnect` and its hold while the status cannot be read (§7) |
| `src/server/orchestrator/sse-connection-manager.ts` | `connect()` keeps the promise an earlier caller awaits across reconnects (§7) |
| `src/server/orchestrator/turn-adoption.ts` | Wires an already-running worker turn into a runner + proxy via `executeAgentTurn`; new use and the answer hold for a CLI-started one (§6) |
| `src/server/orchestrator/turn-executor.ts` | `TurnInput.adopt` — skip env-prep + spawn, keep everything else |
| `src/server/orchestrator/proxy-agent-process.ts` | Optional `runToken` so an adopting proxy inherits the worker's spawn epoch |
| `src/server/orchestrator/restart-turn-reattach.ts` | Boot sweep: probe rediscovered containers, reattach the live ones — and (docs/242) reclaim the stale idle ones; `followReportedTurn` for the worker's own-turn report (§6); then finalize the rows of turns their worker reports as ended (`workerReportsNoTurn`); `followLater` and `runnerForContainerCall` (§7) |
| `src/server/orchestrator/chat-history.ts` | `sessionsWithInProgressRows`, and `finalizeInheritedInProgress` (only rows an earlier process wrote) |
| `src/server/orchestrator/runner-registry-factory.ts` | Finalizes the rows when a runner is created for a new container |
| `src/server/orchestrator/bootstrap-managers.ts` | Fires the sweep after the runner registry exists |
| `src/server/orchestrator/integration_tests/restart-turn-adoption.test.ts` | Real worker + fresh runner: adoption, exactly-once persistence, post-turn flow, run-token correlation, and the two must-not-adopt cases; a turn that ended during the restart keeps its rows past the next turn (through the boot sweep, and through the first connect, also when a message arrives first), and a live one is saved once |
| `src/server/orchestrator/integration_tests/restart-cli-started-turn.test.ts` | §6 against a real worker, runner and sweep: the three moments, the saved rows of the turn before, the message that must not kill the turn, the update that must not reclaim it, and what must not be adopted (a one-shot process, a killed or replaced process's late output, a backend that starts no turns) |
| `src/server/orchestrator/integration_tests/restart-unfollowed-turn.test.ts` | §7 against a real worker, runner registry and sweep: a sent turn across a restart when the sweep's probe fails, when the first connect cannot read the status (a viewer's runner, the worker's report, a container call, the idle reclaim, disposal during a read, a second restart), on an update, and when the orchestrator is down as the turn's next events come |
| `src/server/orchestrator/restart-turn-reattach.test.ts` | Sweep: adopts live turns, never wakes idle/standby/archived sessions, survives one dead worker; finalizes only the rows of turns their worker reports as ended |
| `src/server/orchestrator/runner-registry-factory.test.ts` | A runner for a new container finalizes the rows; one that reconnects does not |
