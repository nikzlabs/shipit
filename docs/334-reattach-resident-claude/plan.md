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
next turn (WS or dispatched), before the spawn guards
  └─ runner.attachIdleResident(): fresh /agent/status ──► proxy on the process's runToken
       restore applied identity, permission mode, status-card value, resident route, background tasks
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
  params — what the process really got — and updates the mode on each
  `/agent/permission-mode`. The dispatched path spawns with no mode in its
  params while it records the turn's mode as applied; the worker's value is
  the true one.
- `/agent/status` reports them as `resident` while a process holds the slot
  and its start named an identity, and reports the current
  `backgroundTasks` list next to the count.

A worker from an older build reports no `resident`, and its process is
replaced as before (Known limits).

### 2. The runner restores them (req 3)

`restoreResidentSpawn` sets `appliedSpawnIdentity`, `appliedPermissionMode`
and the status-card record (`recordStatusCardSpawn`) from the report. The
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

`ContainerSessionRunner.attachIdleResident()`, at the start of a turn and
before the spawn guards:

1. Nothing to do when the runner already holds an agent.
2. Wait for the first connect's status reading, at most 10 s. The first
   connect records an idle streaming process as `_unfollowedResident`
   (planning#639). The stream need not be open: the reading moved the replay
   point, so the turn's events are replayed when it opens.
3. Read `/agent/status` again. The first reading can be old — a viewer may
   have opened the session long before — and an unfollowed process that
   exited has no target for its `agent_done`. Attach only when the reading
   still names the same run token, a streaming process, no turn and no
   self-wake, and a `resident` record.
4. Install a proxy on the process's run token (`createAgent`), restore the
   facts (piece 2), seed the background-task list from the reading, and set
   `isStreamingActive`.

Both turn paths call it before their guards: `dispatched-turn.ts` (first
attempt) and `ws-handlers/agent-execution.ts` (when the turn streams — its
only reuse rule). The dispatched path attaches also with live steering off,
as it reuses a held resident then ("reuse follows the resident process").

**Why at the turn, not at the first connect.** An attached proxy with no turn
has no listeners. While the process stays unfollowed, a turn the CLI starts
by itself is still adopted from its first event (`adoptOwnTurnAt`); once a
turn has taken the process, that turn's listeners follow later ones, as for
any resident (req 4).

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
  worker holds no attachable process still gets no runner (the reason of
  docs/333 piece 3 step 4). In local mode no process survives a restart, so a
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

The cold first resume of docs/333 ("Verify first" 1) reproduces only with
that probe's raw invocation (`claude --print … --model haiku`, without
ShipIt's flags): a first resume wrote 6,935 tokens again, also with
`--allowedTools`, ShipIt's appended instructions or `NODE_ENV=development`.
And most of it is not a new-process effect: when the first process runs a
second turn before the resume, that second turn misses (8,571 written) and
the first resume after it writes only 2,399. Through ShipIt's spawn the same
first-turn effect shows as A2 above, inside one process. So the cost
docs/333 attributes to a new process is paid once per conversation, on its
second request, in whichever process makes it. Why the raw invocation
differs more was not found.

**Consequence.** Under these conditions, taking the process over saves no
cache cost against starting a new one. What it does keep: the process and
its background tasks, which the next turn's `/agent/start` used to kill
(req 4); and the spawn facts, without which a model change after a restart
never replaced an adopted process (req 3). The reasons of docs/333 req 13 and
piece 3 step 4 rest on the docs/333 probe, which these runs do not support;
whether to revisit them is the user's decision (planning#699).

## Known limits

- **A container from an older worker build** reports no `resident` record,
  so its process is replaced as before. A deploy that changes the build
  destroys stale idle containers at boot anyway (docs/333 req 13); only a
  stale container kept for live work is affected, and only on the first
  deploy of this feature.
- **The first turn after a restart waits for the first connect** (one status
  reading, at most 10 s) and one more status reading.

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

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/agent-types.ts` | `spawnIdentity` on the start body; `resident` and `backgroundTasks` on the status; `setSpawnIdentity` on `AgentProcess` |
| `src/server/session/agent-controller.ts` | Keep and report the spawn facts and the task list |
| `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts` | Carry the identity into `/agent/start`; `attachIdleResident`, `restoreResidentSpawn`, `residentToAttach` |
| `src/server/orchestrator/turn-executor.ts` | Compute the identity before the spawn and give it to the agent |
| `src/server/orchestrator/dispatched-turn.ts`, `ws-handlers/agent-execution.ts` | Attach before the spawn guards |
| `src/server/orchestrator/restart-turn-reattach.ts` | `attachableResident`, `workerIdleResident` |
| `src/server/orchestrator/services/idle-compaction.ts` | The resident check of piece 4 |
