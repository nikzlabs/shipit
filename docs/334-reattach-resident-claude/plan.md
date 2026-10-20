---
issue: planning#700
title: Re-attach the resident process — design
description: The worker keeps what each resident process was started with; after an orchestrator restart, the session's next turn takes the idle process over with those facts, so the spawn guards still apply and its background tasks survive.
---

# 334 — Re-attach the resident process: design

Implements [requirements.md](./requirements.md). Ends the exception of
[docs/333 req 16](../333-idle-compaction/requirements.md).

## Shape

```
spawn ──► executor: identity = desiredSpawnIdentity(...) ──► agent.setSpawnIdentity, runner.appliedSpawnIdentity
          worker /agent/start keeps { spawnIdentity, sessionStatusCard, permissionMode } with the process
orchestrator restart (container and process survive)
first connect ──► /agent/status: idle streaming process ──► runner._unfollowedResident (planning#639, unchanged)
next turn (WS or dispatched; not a rebase step), before compaction-before-turn and the spawn guards
  └─ runner.attachIdleResident(): fresh /agent/status ──► proxy on the process's runToken
       restore identity, permission mode, status-card value, MCP servers, resident route, tasks
       tended until a turn takes it: a CLI-started turn is still adopted, an exit releases it
  └─ spawn guards (unchanged) ──► retire it when the session no longer matches   (req 3)
  └─ reuse ──► /agent/message to the warm process                              (req 1)
in-flight adoption (both paths) ──► the same restore                              (req 3)
idle compaction, no runner ──► probe the worker; attach; compact on the process  (req 2)
```

## Pieces

### 1. The worker keeps the spawn facts (req 3)

A reused process keeps what it was started with: the harness, service,
billing mode, model and shaping (`sessionSpawnIdentity`), the tool list of the
status-card setting (docs/303 req 21), and its permission mode. Before this
feature only the runner held them, so a restarted orchestrator knew none of
them. `releaseResidentOnSpawnChange` then keeps the process for ever
("Adopted processes can have an unknown identity"), and a model change after
the restart never reaches it — today already true for an adopted turn
(verified at `resident-spawn-guard.ts:releaseResidentOnSpawnChange`, and no
model-switch path retires a resident by itself).

The process is the record, so the worker keeps the facts with it, as it keeps
the run token:

- `WorkerAgentStartBody.spawnIdentity` — the executor computes the identity
  once, before `agent.run`, gives it to the agent (`setSpawnIdentity`, carried
  by `ProxyAgentProcess` into the start body) and stores it on the runner, as
  it did after the spawn.
- The worker takes `sessionStatusCard` and `permissionMode` from the start
  params — what the process really got. It updates the mode on each
  `/agent/permission-mode`, and on each change the CLI reports by itself (an
  init's mode, a main-thread `EnterPlanMode`: `reportedPermissionMode` in
  `shared/cli-permission-mode.ts`, the same reading the orchestrator's
  listeners make). The dispatched path spawns with no mode in its params
  while it records the turn's mode as applied; the worker's value is the true
  one.
- `/agent/status` reports them as `resident` while a process holds the slot
  and its start named an identity, together with the declared MCP servers the
  process holds (`liveServiceMcp`, docs/327), and reports the current
  `backgroundTasks` list next to the count.

A worker from an older build reports no `resident`, and its process is
replaced as before (Known limits).

### 2. The runner restores them (req 3)

`restoreResidentSpawn` sets `appliedSpawnIdentity`, `appliedPermissionMode`,
the status-card record (`recordStatusCardSpawn`) and the MCP record
(`recordServiceMcpSpawn`) from the report. The
resident route comes from the on-disk record (`recoverResidentRoute`), as
adoption already reads it. Three callers:

- the idle attach (piece 3);
- adoption of a turn in flight at the first connect (`adoptWorkerTurn`);
- adoption of a turn the CLI starts by itself on an unfollowed process
  (`adoptOwnTurnAt`), from the first connect's reading.

With the facts restored, the guards that already run before every reuse —
spawn identity, account (`residentRouteNeedsRelease`), status card, pending
rewind, MCP servers — retire the process when the session no longer matches,
and the turn's permission mode is sent when it differs. No guard changes.

### 3. The idle attach (req 1, 4)

`ContainerSessionRunner.attachIdleResident()`, at the start of a turn:

1. Nothing to do unless `residentToAttach`: the runner holds no agent, the
   container is not still being created, and the worker holds an unfollowed
   process or has not been read yet. The callers check it first, so a turn
   on a held process adds no await.
2. Wait for the first connect's status reading — only the reading, which has
   its own 3 s limit; the stream need not be open, because the reading moved
   the replay point and the turn's events are replayed when it opens. The
   first connect records an idle streaming process as `_unfollowedResident`
   (planning#639). `_statusRead`, not the start of the first connect, says
   whether that reading is done: a message that arrives while a viewer's
   reading is under way still attaches.
3. Read `/agent/status` again. The first reading can be old — a viewer may
   have opened the session long before. Attach only when the reading still
   names the same run token, a streaming process, no turn and no self-wake,
   and a `resident` record. An unfollowed process's `agent_done` or
   `agent_error`, which has no target, also clears the mark.
4. Install a proxy on the process's run token (`createAgent`), restore the
   facts (piece 2), seed the background-task list from the reading, and set
   `isStreamingActive`.
5. **Tend the proxy until a turn takes it** (`tendUntilTaken`). Nothing else
   listens to it then. It keeps the unfollowed mark, so a turn the CLI starts
   by itself is still adopted from its first event (`adoptOwnTurnAt`, req 4);
   it keeps the task list current; an exit releases the runner's resident
   state. A turn takes it with `reused`, and from then on that turn's
   listeners follow it, as for any resident. A guard that retires it, or
   another process that takes the slot, ends the tending (`superseded`).

Both turn paths call it **before compaction before a turn** — whose decision
reads the process's background work — and before their spawn guards:
`dispatched-turn.ts` (at the start of the dispatched turn) and the composer
path (`decideCompactBeforeTurn` and `runAgentWithMessage`, when the turn
streams — its only reuse rule). The dispatched path attaches also with live
steering off, as it reuses a held resident then ("reuse follows the resident
process"). **A driver-owned turn (`postTurn: "none"`, the rebase step) does
not attach**: its admission ends the resident so that the step runs on a
process of its own, and req 1 keeps that path as it is.

**Background tasks** (req 4). The first connect moves the replay point past
the worker's earlier `agent_background_tasks` event, so the runner would
think the process idle. The seeded list keeps every check that reads
resident work right (`residentBackgroundWork`, idle compaction's busy check,
compaction before a turn). Before this feature such a process was killed by
the next turn's `/agent/start` (409, then a targeted kill in
`postAgentStart`), and its tasks with it.

**Harness-neutral.** The attach follows the resident process, as restart
adoption does; it names no harness. A Codex session with live steering keeps
a resident too and is attached the same way. Codex reads its cache warm
across processes (docs/333 "Verify first" 1b), so for it the gain is the kept
process and its background work.

### 4. Idle compaction (req 2)

`services/idle-compaction.ts` drops a fire when the warm cache can only be
read by a resident process and none is reachable. That check changes:

- **No runner** (every session after a restart): not blocked by itself. The
  fire reads the worker's status (`workerIdleResident`,
  `restart-turn-reattach.ts`) before it creates a runner, so a session whose
  worker holds no attachable process with no background task still gets no
  runner (the reason of docs/333 piece 3 step 4). The checks run again after
  that reading: the container can have been reclaimed meanwhile, and a runner
  would start a new one. In local mode no process survives a restart, so a
  runner-less session is still dropped.
- **A runner with no agent**: not blocked while it knows an unattached
  process, or has not read the worker yet (`residentToAttach`).
- **After `attachRunner`**, which now calls `attachIdleResident`, the check is
  strict: the runner must hold the streaming process.

`isWaiting` (the idle enforcer's order, docs/333 req 8) uses the first two
rules. A wrong guess costs one enforcer pass: the fire is dropped, and the
next pass stops the session.

### 5. What does not change (req 1)

Every other path that ends the resident process still ends it (user's answer,
2026-10-19): the process exited or crashed (`turn-executor.ts`,
`agent-listeners.ts`), its credential was rejected or removed
(`agent-auth-handler.ts`, `services/settings.ts`), the account moved
(`agent-execution.ts`, `dispatched-turn.ts`), the user killed it
(`services/recovery.ts`), a rewind forks it (`rollback-handlers.ts`), a
rebase's conflict-resolution step runs on a process of its own
(`session-runner.ts`, `services/rebase-driver.ts`, `api-routes-git.ts`), or a
spawn guard retires it. The answer path of `send-message.ts` already keeps a
resident process.

## Probe

Run on 2026-10-19 in a session container: Claude Code 2.1.300, the user's
subscription, a real `SessionWorker` with the real `ClaudeAdapter` (so the
CLI gets ShipIt's own flags: `--allowedTools`, `--mcp-config`,
`--permission-prompt-tool`, the full model id, ShipIt's appended
instructions). The workspace is a clone of this repository. The "previous
orchestrator" drives the worker over HTTP. After it "restarts" (its stream
closes, the worker keeps the process), a new `ContainerSessionRunner` calls
the real `attachIdleResident()` and sends the next turn through the proxy.
The control then does what the next turn did before this feature: it kills
the process and starts a new one that resumes the conversation. Scripts and
logs: `/persist/reattach-probe/` (not committed).

### 1. The taken-over process reads the warm cache — true

`claude-sonnet-5-5`, a commit and an untracked file made before the control:

| Run | Process | Context | cache read | cache write |
|---|---|---|---|---|
| A1 | new session | 67,141 | 36,276 | 30,863 |
| A2 | same process, second turn | 67,186 | 55,778 | 11,406 |
| B1 | **taken over after the restart** | 67,231 | **67,159** | 70 |
| C1 | control: new process, first resume | 67,277 | 67,204 | 71 |
| C2 | control: same new process, next turn | 67,324 | 67,250 | 72 |

The worker reported the idle process with its spawn facts
(`resident: {"spawnIdentity": …, "sessionStatusCard": false}`, `turnActive:
false`), the runner took it over, and the turn read everything but its own
new message (B1). Req 1 holds.

### 2. A new process does NOT write the conversation again — the premise of planning#700 does not hold through ShipIt's spawn

The control C1 was as warm as B1. The same in every run through ShipIt's
spawn path:

| Model, workspace | First resume in a new process: read / write |
|---|---|
| `claude-haiku-4-5` (ShipIt's `haiku`), scratch repo | 41,344 / 92 |
| `claude-haiku-5-5`, scratch repo | 48,005 / 108 |
| `claude-sonnet-5-5`, clone of this repo | 67,204 / 71 |
| `claude-sonnet-5-5`, clone, after a commit and an untracked file | 67,204 / 71 |

The cold first resume of docs/333 ("Verify first" 1) reproduced only with
that probe's raw invocation (`claude --print …` without ShipIt's flags): a
first resume wrote 6,935 tokens again with `--model haiku` and with
`--model claude-haiku-5-5`, also with `--allowedTools`, ShipIt's appended
instructions or `NODE_ENV=development`; with `--model claude-haiku-4-5` it
was warm. Part of that miss is not a new-process effect: when the first
process ran a second turn before the resume, that second turn missed (8,571
written), and the first resume after it wrote 2,399. Through ShipIt's spawn a
second turn in the same process missed too (A2 above). A hypothesis, not
shown: the first request of a conversation differs from the later ones,
whichever process makes them. Why the raw invocation misses more was not
found.

**Bounds.** These are short, immediate exchanges of one-word answers, a few
minutes apart, on one container. They do not show behaviour for a long,
tool-heavy context, an older cache, or other environments.

**Consequence.** Under these conditions, taking the process over saved no
cache cost against starting a new one. What it does keep: the process and
its background tasks, which the next turn's `/agent/start` used to kill
(req 4); and the spawn facts, without which a model change after a restart
never replaced an adopted process (req 3). The reasons of docs/333 req 13 and
piece 3 step 4 rest on the docs/333 probe, which these runs do not support;
whether to revisit them is the user's decision (planning#699).

## Known limits

- **A turn the CLI starts during another turn's setup** (planning#703). If a
  background task self-wakes while the first turn after a restart sets up,
  the restart adoption follows it, and the incoming turn then takes the
  process from it (the docs/329 handover), which can lose the adopted turn's
  saved transcript prefix and settle the incoming turn on its result. And
  when the take-over's status reading sees that turn before the stream
  delivers it, the take-over declines, and the incoming turn's new process
  kills the survivor — what every first turn after a restart did before this
  feature. Both races exist without it; it adds up to two status readings to
  the setup window.
- **An exit during the second status reading.** If the process exits after
  the worker answers and before its `agent_done` reaches the runner, the turn
  sends its prompt to a process that is gone; the worker refuses it, and the
  runner's resync (`verifyRunningState`) ends the turn with its "out of sync"
  notice. The window is one HTTP round trip on the first turn after a restart.
- **A container from an older worker build** reports no `resident` record,
  so its process is replaced as before. A deploy that changes the build
  destroys stale idle containers at boot anyway (docs/333 req 13); only a
  stale container kept for live work is affected, and only on the first
  deploy of this feature.
- **The first turn after a restart waits for two status readings** (each at
  most 3 s).

## Rejected alternatives

- **Attach at the first connect.** A proxy with no listeners would drop the
  events of a turn the CLI starts by itself (piece 3).
- **Read the spawn facts from the session row at attach.** The row can change
  while no runner holds the process — exactly the change the guard must see.
- **Keep the spawn facts on disk in the orchestrator**, next to the resident
  route record. A file can describe a process that no longer exists; the
  worker's report is tied to the run token it describes.
- **Refuse to attach a process with background tasks.** Its next turn then
  kills the process and its tasks, which req 4 forbids.

## Review resolution

ShipIt reviewer run 2ab8f35e-1493-4791-992a-3894de3a6332 reviewed the first
implementation. Accepted and fixed: a proxy taken over but not used by a turn
(an idle compaction refused after the attach) had no listeners, so a turn the
CLI started was lost — it is now tended until a turn takes it; a message that
arrived while a viewer's first reading was under way did not attach — the
gate is now the finished reading; a rebase step attached the process its
admission had meant to replace; the worker did not follow mode changes the
CLI reports by itself; the MCP servers were not restored; the background
tasks were restored after compaction-before-turn had decided; the idle
compaction's worker reading could be followed by a runner for a container
reclaimed meanwhile; an unfollowed process's exit did not clear its mark; the
probe's explanation said more than it measured. Not changed: a turn the CLI
starts during a dispatched turn's setup is taken by that turn, as the docs/329
handover already does without a restart, and a forced disposal during setup
is possible at the awaits that setup already has.

A second run, cb5f3960-aa1e-4a33-9455-15db4e50f835, confirmed those fixes and
found one more, fixed: adopting a turn the CLI starts on a tended proxy
restored the first connect's older reading over the facts the take-over had
restored. It also argued that the first "not changed" race loses a
transcript prefix and settles the incoming turn on the wrong result. That is
true, and true before this feature; it is a known limit, filed as
planning#703.

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/agent-types.ts` | `spawnIdentity` on the start body; `resident` and `backgroundTasks` on the status; `setSpawnIdentity` on `AgentProcess` |
| `src/server/session/agent-controller.ts`, `shared/cli-permission-mode.ts` | Keep and report the spawn facts, the MCP servers and the task list; follow the CLI's own mode changes |
| `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts` | Carry the identity into `/agent/start`; `attachIdleResident`, `tendUntilTaken`, `restoreResidentSpawn`, `residentToAttach` |
| `src/server/orchestrator/turn-executor.ts` | Compute the identity before the spawn and give it to the agent |
| `src/server/orchestrator/dispatched-turn.ts`, `ws-handlers/agent-execution.ts` | Attach before compaction-before-turn and the spawn guards |
| `src/server/orchestrator/restart-turn-reattach.ts` | `attachableResident`, `workerIdleResident` |
| `src/server/orchestrator/services/idle-compaction.ts` | The resident check of piece 4 |
