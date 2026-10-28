---
issue: planning#246
title: Agent self-wake liveness
description: Teach the orchestrator that a self-woken agent turn (background task completion) is real work, so idle eviction and disk-tier escalation stop tearing the container down underneath it.
---

# Agent self-wake liveness

## Problem

Every container-reclaim path in ShipIt decides "is this session busy?" by reading
`runner.running`. That flag is only ever set by an **orchestrator-initiated**
turn:

| Set true at | Path |
|---|---|
| `ws-handlers/send-message.ts:477,601` | user typed a message |
| `ws-handlers/agent-execution.ts:104` | queued message shifted |
| `turn-executor.ts:188` | dispatched / system turn |

Nothing sets it from the other direction. But the Claude CLI can start a turn on
its own: a `Bash(run_in_background: true)` job finishing re-invokes the model,
as do `ScheduleWakeup`, `Monitor`, and `CronCreate`. During such a turn the
orchestrator still reads `running: false`, so the session is fully eligible for:

- **Idle eviction** — `idle-enforcer.ts:109` skips only `runner.running`
  sessions. A viewer-less session whose agent self-woke counts as idle.
- **Disk-tier escalation** — `tier-escalation.ts:109` (`canAutoDescend`) uses the
  same flag; at 24h idle age `hot → light` disposes the runner and destroys the
  container outright.

Two aggravating details make the window wider than it looks:

- A runner that never had a viewer has `lastViewerDetachAt === 0`, and the
  10-minute grace check is written `runner.lastViewerDetachAt > 0 && …`
  (`idle-enforcer.ts:117`), so the cushion is skipped entirely for it.
  Agent-spawned child sessions land here.
- Under host memory pressure (≥85%, `MEMORY_PRESSURE_EVICT_THRESHOLD`) effective
  `maxIdleContainers` drops to 0 **and** the grace period is bypassed, so a
  self-woken session dies on the next 30s tick.

### The second, quieter bug

Agent listeners are removed only at the *start* of the next turn
(`agent-execution.ts:246`, `dispatched-turn.ts:207`) — never on `result`. For a
resident streaming process the previous turn's listener closure is therefore
still attached when the self-wake fires, and the wake turn's events run through
it. **Corrected during implementation** — the original draft claimed this
re-runs the post-turn flow under a stale session id. Tracing the code shows the
opposite, and the real defects are these two:

1. **Turn state is never reset.** `resetRunnerTurnState` is called only from
   `turn-executor.ts:190`, at the start of a turn the orchestrator *starts*.
   Nothing calls it for a turn the CLI starts on its own, so the wake turn's
   output accumulates on top of the previous turn's `chatMessageGroups` and its
   `agent_result` persists the combined set — **duplicating the earlier turn in
   the transcript**. Latent while nothing rendered the wake turn; visible the
   moment we surface it. Fixed here (§6).
2. **The post-turn flow does not fire at all.** `turn-executor` guards it with
   first-wins flags scoped to one `runTurn` invocation (`streamingPostTurnFired`,
   `drainFired`, `tokenSyncFired`), so the wake turn's `agent_result` returns
   early. A self-woken turn that edits files therefore gets **no auto-commit, no
   push, and no PR card** until the next user turn. Split out of this doc's PR
   and fixed under planning#249 — see §6.

`capturedSessionId` is *not* stale, which is why persistence still lands in the
right session: it is the ShipIt session id, constant for the runner's lifetime.

## Can the CLI actually report it? Yes — verified

Probed against the CLI in the session-worker image (`claude 2.1.219`) in
`--print --input-format stream-json --output-format stream-json` mode, i.e. the
exact `StreamingClaudeProcess` invocation. Prompt: start a backgrounded
`sleep && echo`, end the turn, send nothing further on stdin.

Observed stdout timeline (`work3` run, timestamps from spawn):

```
 4492ms  system/background_tasks_changed  tasks:[{task_id, task_type:"local_bash", description}]
 4492ms  system/task_started              task_id, tool_use_id, description, task_type
 5999ms  result/success                             <- turn 1 ends
                                                    <- NO stdin written after this point
14503ms  system/background_tasks_changed  tasks:[]
14504ms  system/task_updated              task_id, patch:{status:"completed", end_time}
14504ms  system/task_notification         task_id, tool_use_id, status, output_file, summary
14504ms  system/init                                <- fresh init: a new turn is starting
        …assistant thinking / text…
17869ms  result/success                             <- turn 2 ends
```

The self-woken turn is **fully bracketed on the wire**: it opens with
`task_notification` + a new `system/init` and closes with a `result`. Two
independent signals are available:

1. **Edge** — `task_notification` / a `system/init` arriving while no
   orchestrator turn is in flight ⇒ a turn just started.
2. **Level** — `background_tasks_changed` carries the *complete current task
   list*; a non-empty `tasks` array means outstanding background work exists
   even before it wakes anything. Empty array = drained.

The level signal is the more valuable one: it lets the enforcer protect a session
that has pending background work but is momentarily between turns, which is
exactly the state that gets reaped today.

**No new CLI flag is needed.** The probe was first run with
`--include-hook-events` and then repeated without it; the `task_*` and
`background_tasks_changed` events appear identically in both. They are on the
wire in ShipIt's current invocation right now.

### Why ShipIt sees none of it

`ClaudeSystemEvent` (`shared/types/claude-types.ts:82`) models only
`init | status | compact_boundary`. The adapter's inner switch
(`session/agents/claude/adapter.ts:190`) ends in `default: return null`, so all
four subtypes are silently dropped at the adapter boundary and never become
`AgentEvent`s. The `system/init` of the wake turn *does* map to `agent_init` —
which is why the wake turn's events reach the orchestrator at all today, just
without anything marking the runner busy.

## Design

Keep `running` meaning what it means (an orchestrator-owned turn is in flight)
and add a separate, additive liveness axis. Reclaim paths consult the union.

### Why `running` cannot simply be set true

There are two distinct states, and only one of them is a turn:

| State | Agent | Today | Wanted |
|---|---|---|---|
| Self-woken turn in flight | thinking | invisible | busy + spinner |
| Background task pending, between turns | idle, will wake later | invisible | **not idle**, and visibly pending |

The tempting shortcut — set `running = true` whenever a background task exists —
breaks message dispatch. `ws-handlers/send-message.ts:124` branches on
`runnerForQueue?.running`: a user message arriving while the flag is true is
**queued behind the in-flight turn, or steered into it mid-turn** rather than
starting a fresh one. In the second row above there is no turn to queue behind
and no live CLI read loop to steer into, so a user who types during a pending
background task would have their message parked until something else happened to
start a turn. `running` must keep meaning "a turn is in flight"; pending
background work is a second, orthogonal axis.

### 1. Type and map the events

`claude-types.ts` — add `ClaudeTaskStartedEvent`, `ClaudeTaskUpdatedEvent`,
`ClaudeTaskNotificationEvent`, `ClaudeBackgroundTasksChangedEvent` to the
`ClaudeSystemEvent` union.

`adapter.ts` — map them to two normalized, agent-neutral `AgentEvent`s:

- `agent_background_tasks` — `{ tasks: { id, type, description }[] }`, from
  `background_tasks_changed`. The level signal.
- `agent_self_wake` — `{ taskId, summary, status }`, from `task_notification`.
  The edge signal.

Agent-neutral on purpose: Codex has no equivalent today, and its adapter simply
never emits them, which degrades to exactly current behavior.

### 2. Carry them to the orchestrator

Both ride the existing worker → orchestrator SSE agent-event channel; no new
transport. `ProxyAgentProcess` already forwards unknown `AgentEvent`s.

### 3. Runner state

`SessionRunnerInterface` gains:

```ts
readonly backgroundTaskCount: number;
readonly agentBusy: boolean;
```

`agent-listeners.ts` sets `backgroundTaskCount` on `agent_background_tasks`. On
`agent_self_wake` it flips `runner.running = true` and emits `session_status` so
the sidebar spinner reflects the self-woken turn — the existing `agent_result`
handler already clears it.

`agentBusy` must be cleared on agent process death (`done`/`error` in
`agent-listeners.ts:1187`), otherwise a crashed CLI leaves a permanently
unreclaimable runner — the same failure mode the existing `running = false`
reset there guards against.

### 4. Reclaim paths consult `agentBusy`

- `idle-enforcer.ts:109` — `if (runner.agentBusy) continue;` and the same in the
  TOCTOU re-check at `:134`.
- `tier-escalation.ts:109` — `canAutoDescend` returns false on `agentBusy`.

Memory pressure deliberately keeps its override for `viewerCount`, but **not**
for `agentBusy`: killing a container mid-turn is what this doc exists to stop.
A session with outstanding background work is real work, the same as a running
agent. If the host genuinely has no headroom the OOM breaker is the correct
backstop, not silent eviction.

### 5. Surface the pending state in the UI

Not-idle is necessary but not sufficient: a session with background work pending
must *look* like something is happening, or the user reads a silent session as
finished. Four surfaces, all driven off the one `backgroundTaskCount` already
added in §3.

**5a. Live push.** A dedicated `background_tasks` WS message
(`ws-server-messages/session.ts`) — `{ sessionId, count, descriptions }`, emitted
on each `agent_background_tasks`. `descriptions` comes straight from the CLI's
task list and is what lets the chat line name the work instead of showing a bare
count.

> **Corrected after shipping.** This first rode along as an optional
> `backgroundTasks` field on `WsSessionStatus`, which forced every task-list
> update to also fill in a `running` value. `session_status` is a *turn
> transition* on the client — it adds/removes the session from
> `activeRunnerSessions` and drives the chat spinner — and the wire trace above
> shows the CLI drains the task list at 14503ms, **1ms before** the
> `task_notification` at 14504ms that marks the runner busy again. So that
> message carried `running: false` at the exact moment a turn was starting: the
> client dropped the running indicator and `useAttentionNotifications` fired the
> "Waiting for your input" chime, then flipped back a frame later. The same hole
> opened whenever a task-list change landed inside `handleSendMessage`'s setup
> window, where the runner isn't flagged `running` yet. Splitting the level
> signal onto its own message means a background-task update can no longer assert
> anything about turn state — the client handler (`background-tasks.ts`) owns the
> `backgroundTaskSessions` axis and nothing else, and only touches the chat
> spinner/status line while no turn is running (mid-turn, the turn owns them).
> The client stores the descriptions alongside the marker
> (`backgroundTaskSessions: Map<string, string[]>`) because the status line is
> restored at *turn end*, long after the message that carried them.
>
> Paired with it: `useAttentionNotifications` now requires an attention reason to
> hold for a settle window before it notifies. Sub-second `null → "Waiting for
> your input" → null` blips are structural (this drain/wake gap; a turn ending
> with a queued message behind it, which goes idle until the drain starts the
> next turn), and a chime for one of them tells the user their agent stopped
> while it is visibly working. A session that genuinely stopped keeps its reason
> and notifies a beat later.

**5b. First paint and reconnect.** The live push alone is not enough — a page
reload or a backgrounded mobile tab would show nothing while the task is still
running. The sidebar's running dots are reconciled wholesale from the
authoritative `active_runners` SSE snapshot (`route-registry.ts:101-112`), which
is derived from `runner.running` and therefore blind to this state. Add a
parallel `backgroundTaskSessionIds` to the adjacent `session_attention` snapshot
emitted three lines below — that event already carries
`awaitingPermissionSessionIds` for exactly this reason (a state the client cannot
re-derive after a reconnect), so it is the established precedent rather than a
new mechanism.

> **Corrected after shipping — the "live push" never reached the sidebar.** This
> section reads the snapshot as a top-up on a live push that already worked. It
> did not: the live push is `background_tasks`, emitted through
> `runner.emitMessage`, which reaches only the clients attached to *that
> session's* WebSocket — and a browser holds exactly one. So the cross-session
> marker was populated **only** by the connect snapshot, and covered only work
> already outstanding when the SSE opened. Work that started afterwards — the
> common case, a `shipit agent run` consult backgrounded mid-session — left the
> session reading as idle in the sidebar until the user either reloaded the page
> or *opened* the session, whose WS attach replayed `background_tasks` and lit
> the dot then. (Reported as: "a session that requested a review using shipit
> agent is not shown as active until I open it, then the status updates.")
>
> Fix: the incremental counterpart of the snapshot. `agent_background_tasks` now
> also `sseBroadcast`s `session_attention { sessionId, backgroundTasks }` —
> descriptions, not ids, so a switch gets the named label instead of the
> snapshot's unnamed fallback; an empty list means drained. The client applies
> each live axis only when its own field is present, so a background-task
> transition cannot clear an outstanding permission prompt's signal.
>
> The drain needs saying explicitly on the paths where the process *dies*
> (`turn-executor`'s `done`, `agent-listeners`' process `error`): those call
> `clearBackgroundTasks()` but the CLI is gone and emits no draining event, so
> without a broadcast there the marker would keep a dead session pulsing green
> in every sidebar until the next SSE connect. Container disposal is covered on
> the client instead — the existing `session_status` idle-disposal handler now
> drops the background-work marker alongside the running one, since a reaped
> container can hold nothing outstanding.
>
> **Superseded by 5h.** Announcing per call site is what left the *other* five
> clears silent. The runner announces its own changes now, and the per-site
> broadcasts described above are gone.

**5g. The marker is the UNION with in-flight consults, not the task list.**
Added by planning#246 after a cross-backend review pointed out that the fix above
still missed its own reported workload. §5a–5f all read
`backgroundTaskDescriptions`, the list the CLI reports — and a brokered
`shipit agent run` consult is invisible in it three ways over: it outlives the
turn that started it (docs/236 makes backgrounding the recommended shape), it
needs no resident streaming process (so the tracker's liveness gate zeroes the
count), and **Codex reports no background tasks at all**, so a Codex-pinned
session never populates the list in the first place.

The orchestrator already owns the missing fact. `subAgentSpawnsInFlight`
(planning#298) is the in-flight spawn set, and `agentBusy` — the predicate every
container-reclaim path consults — is defined as
`running || backgroundTaskCount > 0 || subAgentSpawnsInFlight > 0` precisely
because the first two are not enough. planning#298 had already been burned by this:
it reaped a live 12-minute Codex review. The UI simply never read the third term.

So the marker becomes `backgroundWorkDescriptions` — one getter on the runner
interface, `backgroundTaskDescriptions` ++ one label per in-flight consult
("Codex consult") — and every surface reads it: the SSE broadcasts, the
`session_attention` connect snapshot, and the `GET /history` payload. The
runners track the consulted `AgentId` alongside each in-flight spawn so the
label can name it, and `services/sub-agent.ts` announces the marker when a
spawn starts and again in its `finally`.

Two consequences worth stating. The process-death broadcasts send the union
rather than a bare `[]`, because a consult routinely outlives its parent turn
and asserting "nothing outstanding" would blank the marker on exactly the
session still waiting on a review. And the announcement at spawn time reads the
runner *after* calling `spawnSubAgent`, relying on both runners registering the
spawn synchronously ahead of their first `await`; a guard test in
`container-session-runner.test.ts` pins that, so an `await` inserted before the
registration is a red build rather than a marker that quietly stops appearing.

> **Corrected after shipping — the chat status line also needs a snapshot.** The
> SSE snapshot restores the *sidebar* marker, but the chat's status line is
> re-established from `GET /history`, and that payload only ever carried
> `agentRunning`. Switching into a between-turns session with a job outstanding
> showed the line for a beat (from a live or attach-replayed `background_tasks`)
> and then blanked, because `loadSessionHistory` read `agentRunning: false` and
> cleared `isLoading`/`activity` unconditionally — while the sidebar kept
> correctly showing the session as working. `background_tasks` is emit-only live
> state buffered into the turn-event log, which the next turn start clears, so
> there was no message left to replay for a session that has been waiting a
> while. Fix: the history payload carries `backgroundTasks: string[]` (the
> runner's descriptions, `[]` with no runner), and hydration reconciles the
> marker for **that session only** and applies the same rule `handleSessionStatus`
> applies at turn end — waiting is not idle, so the bar stays up with the named
> label and no `tool`. Being the payload rather than ids-only, it also upgrades
> the SSE snapshot's unnamed fallback label ("Waiting for a background task to
> finish") to the named one on switch. A running turn still wins: the turn owns
> the status line, so hydration only sets a label when `agentRunning` is false.

**5c. Sidebar — reuse the existing dot, add nothing.** No new indicator, no new
visual state. `SessionStatusDot`
(`SessionSidebar/SessionStatusIndicators.tsx`) already renders a pulsing green
dot at priority 2 for `isAgentRunning`; widen that one condition to
`activeRunnerSessions.has(id) || backgroundTaskSessions.has(id)`. From the
sidebar's altitude the useful fact is binary — *this session is working, don't
treat it as done* — and that is exactly what the green dot already says. A
second glyph would add a distinction the user has to learn in the surface least
able to explain it. The nuance belongs in the chat, where there is room for
words (5e).

Keep the two client sets separate rather than folding background-task sessions
into `activeRunnerSessions`: other consumers of that set
(`PrStatusControls`, `SpawnedSessionCard`, `useAttentionNotifications`) read it
as "a turn is in flight," and silently widening it would change gating on the PR
action buttons as a side effect. OR the two together at each site that should
treat them alike — here and in 5f.

**5d. Chat — replace the label, not the component.** `AgentStatusBar`
(rendered at `App.tsx:1255` behind the `isLoading` gate) already displays a
`StreamingActivity { label, tool? }`. Widen the gate to include pending
background tasks and set the label to
`"Waiting for a background task to finish"` — or, with one task and a
description available, `"Waiting for: sleep 40 && echo LATE"`. Same bar, same
spinner, different words: the user sees the session is alive *and* learns it is
blocked on a task rather than mid-thought, which is precisely the distinction
the sidebar cannot carry. Suppress the `tool` field so the tool-execution
spinner doesn't imply a live tool call.

**5e. Attention.** `computeAttentionReason` (`useAttentionInfo.ts`) currently
falls through to `"Waiting for your input"` for an idle session, which is
actively wrong here — the session is going to speak again on its own. Add
`hasBackgroundTasks` to `AttentionInputs` and extend the existing short-circuit
to `if (isAgentRunning || hasBackgroundTasks) return null;`. Placement matters:
it goes **after** the `awaitingPermission` check, so a session that is both
blocked on a permission prompt and holding a background task still surfaces
"Needs your approval to continue" — the block is the user's to clear regardless
of what else is pending. The same input flows into `useAttentionNotifications`,
so a pending background task also stops firing a spurious "waiting for you" push
notification.

**Persistence:** this is transient live state, so it is emit-only + snapshot
reconcile — deliberately **not** a persisted transcript card. Per the
`CLAUDE.md` rule, spinners and live activity correctly disappear; only transcript
content persists. The wake turn's own output is ordinary agent output and
persists through the normal path.

## How reliable is the signal? Partially — and the gaps are bounded

The level signal's payload is a **complete list, not a delta** (probe: `tasks:[{…}]`
on start, `tasks:[]` on drain), so any single event fully re-states the truth.
That is the good half. Two probes mapped the limits.

**It is emitted only on change — there is no re-sync.** Probe B started a second
turn while a 40s task was still pending:

```
 3672ms  background_tasks_changed tasks=[{task_id:"bvycb6dbf", …}]
 5727ms  result/success                  <- turn 1 ends
 9752ms  system/init                     <- turn 2 starts, task STILL pending
11106ms  result/success                  <- turn 2 ends
                                         ^ no re-statement of the task list
35036ms  background_tasks_changed tasks=[]
```

A new turn and a fresh `init` do **not** re-emit the outstanding list, and there
is no heartbeat for a bash-backed task (measured to 30 minutes below; a
backgrounded *subagent* is the one exception, and not a usable one).
There is also no pull API: the `TaskList` / `TaskGet` /
`TaskOutput` / `TaskStop` tools in the CLI's tool set are *model*-facing, not
callable by the orchestrator over the control protocol. So ShipIt's copy is only
as good as its event delivery, and a dropped event cannot self-heal from the
stream. A stuck non-zero count would make a session permanently unreclaimable —
the same failure class the existing `running = false` reset in
`agent-listeners.ts:1187` exists to prevent.

**But background tasks cannot outlive the CLI process, which bounds the damage.**
Probe A ran the one-shot `-p` PTY path with a backgrounded `sleep 12 && touch
MARKER`. The CLI held ~5s past its `result`, emitted
`background_tasks_changed` / `task_updated` / `task_notification`, exited at
16.8s — and the marker never appeared, at 12s or ever:

```
11473ms  result/success
16495ms  background_tasks_changed / task_updated / task_notification
16787ms  CLI PROCESS EXITED code=0
19791ms→43813ms  marker exists? false   (the 12s sleep never completed)
```

Two consequences, both load-bearing:

1. **This is a streaming-mode-only problem.** With live steering off, ShipIt
   spawns `ClaudeProcess` (one-shot PTY) and the CLI reaps background work at
   turn end. Nothing survives for the container to protect, so today's eviction
   behavior is already correct there. The fix only needs to hold when
   `runner.isStreamingActive`. (The *agent* still has to learn that its work was
   stopped — §9.)
2. **Gate the count on process liveness.** Because a task cannot outlive the
   process, `backgroundTaskCount > 0` is only meaningful while the streaming
   process is alive. Make the getter return 0 unless `isStreamingActive` — that
   is free, and it collapses the largest drift window (process died, drain event
   never arrived) into a correct answer.

**2026-09-09 — how long the silence actually lasts, and the one exception.**
The "no heartbeat" finding above was drawn from a 12s and a 40s task, both far
too short to see one. Three 33-minute probes (claude 2.1.252, same streaming
invocation) settled it:

- **Bash-backed tasks: confirmed, at scale.** A silent `sleep 1800` emitted
  nothing between `result/success` at 5500ms and its drain at 1804090ms. A loop
  printing a line every 15s (120 lines) likewise emitted nothing, 4922ms to
  1804184ms — so task **output** does not drive the wire either.
- **Backgrounded subagents are the exception.** `task_progress` *does* fire —
  6 events, intervals 5759 / 5841 / 29532 / 5003 / 4731 ms. Each carries a
  distinct `desc` naming the subagent's current tool call, and the 29.5s gap
  spans a nested task the subagent itself backgrounded. It is **activity-driven,
  not a timer**: a subagent inside one long tool call emits nothing for that
  call's duration, so it cannot serve as a liveness refresh.
- **The level signal is sound.** Both bash probes emitted
  `background_tasks_changed tasks=[]` exactly at completion. Only the middle is
  silent.

Consequence for the decay below: `seenAt` is set once, at `task_started`, and a
long job can never refresh it — so the TTL is the *whole* protection such a job
gets, not a backstop on top of one. That is why `BACKGROUND_TASK_TTL_MS` is an
hour rather than the ten minutes this section originally implied.

**Residual gap, handled by decay.** A dropped SSE frame while the process stays
alive is still possible. Treat the count as a bounded-lifetime *hint*: record
`backgroundTasksSeenAt` alongside it and honor a non-zero count for at most one
`IDLE_GRACE_PERIOD_MS` window. A missed drain event then costs one grace period
of extra container lifetime and never a permanent leak. The decay deliberately
errs toward *reclaimable*, which is the safe direction for a resource guard.

An orchestrator restart loses the count entirely (it is in-memory runner state),
and the containers outlive it: a deploy no longer removes them
(`deployment/vps/deploy.sh` leaves session containers to startup
reconciliation), so this holds for every update and not only for a crash.
`rediscover` re-adopts surviving containers whose CLI process still holds tasks,
while a rebuilt runner reports a zero count. The count itself is accepted, not
fixed. The worker receives the full list on every `agent_background_tasks`
event but keeps and publishes only how many there are, so restoring the marker
would take publishing the list on `/agent/status` and seeding the runner from it
(not built). The cost is a missing background-work marker, and a session that
is reclaimable under memory pressure while its task runs — which a container
with no runner already was.

What a restart must not lose is the **turn** the task ends in. That was lost
until planning#639 — the wake's events reached a runner with no agent and were
dropped — and is covered in docs/240-turn-survives-orchestrator-restart §6: the
worker counts the wake as a turn and reports it when no orchestrator is
listening, and the runner it gets adopts it.

### 6. Give the self-woken turn its own turn state

The original plan here — "detach the turn's listeners on `result` and re-wire per
turn" — **cannot be implemented as written**: the listener that stays attached
past `result` is exactly what delivers `agent_background_tasks` and
`agent_self_wake`. Detaching on `result` would blind §1–5 to the very events they
depend on. The goal (a self-woken turn is not attributed to the previous turn's
context) is met instead at the wake *edge*:

**Implemented.** The `agent_self_wake` handler calls `resetRunnerTurnState(runner)`
before marking the runner running — the same reset `turn-executor` performs at the
start of a user-initiated turn. The wake turn gets a clean accumulator, so its
output forms its own message group instead of re-persisting the previous turn's.

**Gated on `!runner.running`** (docs/237). `agent_self_wake` rides on the CLI's
`task_notification`, which fires whenever a `Bash(run_in_background)` job
finishes — including a job started *earlier in the current turn*, which commonly
reports back while that turn is still streaming. That is a mid-turn notification,
not a wake, and resetting there destroyed the running turn: clearing
`chatMessageGroups` makes the next tool-result boundary's `replaceInProgress`
delete every `in_progress` row for the session and re-insert from the truncated
accumulator. The live viewer never noticed (it doesn't re-read history), but the
turn's opening was gone from the DB for good — a reload or session switch showed
the turn missing its first half, permanently. Regression test:
`integration_tests/self-wake-midturn.test.ts`.

### 7. Give the self-woken turn its own post-turn flow (planning#249)

Defect 2 in "The second, quieter bug" above — split out of this doc's PR because
it touches auto-commit and PR creation, and landed separately. Production hit it
twice in one hour on the same host, both times via a backgrounded
`shipit agent run --agent codex` consult: the consult ends the parent turn when
backgrounded and self-wakes the CLI ~15 minutes later, so the wake path is the
*normal* case for cross-agent review rather than a corner case. Both sessions
were left with a dirty working tree and no commit.

`turn-executor`'s post-turn guards (`tokenSyncFired`, `drainFired`,
`streamingPostTurnFired`) and its memoized `commitPromise` / `commitAndPrPromise`
are first-wins and scoped to one `executeAgentTurn` call. For a resident
streaming process the wake turn runs through the *previous* turn's still-attached
listener closure, so all of them were already tripped and its `agent_result`
returned early. The executor now listens for `agent_self_wake` itself and hands
that closure a fresh set — `rearmForCliStartedTurn` (named `rearmForSelfWokenTurn`
when this shipped; docs/140 Phase 6.11 added a second edge — top-level assistant
output after a turn's `result` — and renamed it).

**Caveat on edge signal 1 above, added by docs/140 Phase 6.11:** a `system/init`
is NOT on its own proof that a turn started. The CLI also emits one in reply to a
`set_permission_mode` control_request, with no turn behind it and no `result` to
follow — so adopting on a bare init can wedge a session as permanently busy. The
`task_notification` edge is unaffected (it genuinely precedes a wake turn); the
init half of this sentence should not be reused as an adoption signal.

**And a caveat on that caveat, 2026-10-11:** a `task_notification` does not always
precede a turn either. One with `status: "stopped"` for a job the previous process
left is closed by a `result` that ran no model call — see §8.

Three gates make the re-arm safe, and each is pinned by a test in
`turn-self-wake-commit.test.ts` that fails without it:

- **Streaming only.** A one-shot PTY reaps its background tasks at turn end
  (probe A above), so there is nothing to wake. It also drains at `agent_result`
  and commits later in `done`, so clearing `drainFired` between the two would
  drain the queue twice.
- **Only once this turn's own post-turn flow has fired.** `agent_self_wake` rides
  `task_notification`, which also fires for a job started earlier in the *current*
  turn (the docs/237 trap). `agent-listeners` gates on `!runner.running`; the
  executor cannot reuse that test because `agent-listeners` is wired first and has
  already flipped the flag by the time this listener runs. `streamingPostTurnFired`
  is the executor-local equivalent.
- **After the in-flight sequence settles.** A wake can land between
  `streamingPostTurnFired = true` and the finished turn's `runCommitAndPr` — a job
  backgrounded just before the turn ended is exactly that shape. Nulling the memos
  there would let the resumed sequence re-memoize them, and the wake turn would
  get an already-settled flow back and commit nothing. The sequence is therefore
  published as `streamingPostTurn` in the same synchronous block that sets the
  flag, and the re-arm awaits it.

`receivedResult` and `turnCompleteFired` are deliberately **not** reset. They
describe the turn this executor was invoked for: clearing the first would arm the
`done` no-result paths (including dispatch's `onNoResultExit`, which would re-run
the user's original prompt) if the wake turn's process later died, and clearing
the second would settle a dispatch handle twice.

### 8. A resumed conversation announces the job its previous process left

Probe A in §5 shows a one-shot process stopping its background job as it exits.
The conversation it leaves still owes that job a notice, and the **next** process
to resume the conversation pays it before it reads its prompt. Measured
2026-10-11 on claude 2.1.284: process 1 is the one-shot invocation, told to start
a backgrounded `sleep 300` and end its turn; process 2 resumes with a prompt on
stdin. The streaming invocation:

```
  573ms  system/task_notification  status:"stopped", summary:"Background shell command
                                   didn't finish before the previous session ended"
  639ms  system/init
  640ms  result/success            num_turns:0, duration_api_ms:0, result:"",
                                   origin:{kind:"task-notification"}
  657ms  system/init
 1884ms  user (isReplay)           <- the prompt is read only now
 1887ms  assistant …
 1939ms  result/success            num_turns:1, result_index:1
```

The one-shot invocation emits the same sequence, without the replay. Three facts
from the same runs:

- **The first `result` ends no turn.** No model call ran (`num_turns: 0`, zero
  usage, an empty `iterations`), and the CLI says what it answered:
  `origin.kind` is `"task-notification"`. A prompt's own result carries no
  `origin`.
- **It fires once.** A second resume of the same conversation emits neither the
  notice nor the result.
- **The model is still told.** Asked in the resumed turn, it reports the
  unfinished command, so the notice reaches its context with the prompt.

**What it cost.** Every layer reads `agent_result` as "the running turn ended",
and the running turn is the prompt the process was spawned for. Production
2026-10-11, session `83d3273c`: the user's prompt was dispatched on a fresh
streaming process, the notice's result arrived under a second later, and the
executor settled the user's turn — commit, PR flow, idle — while the CLI had not
read the prompt. The session read idle for the 18 s the model then spent
thinking, the answer was adopted as a CLI-started turn (`post-result assistant
output`), and a 401 five minutes later took the adopted-turn path, which does not
re-run a prompt (docs/140-live-steering Phase 6.13). The worker counts the same
way: `AgentController.endTurn` cleared `turnActive` and the delivery id under a
turn that had not begun, and on the one-shot path nothing sets them again.

**The rule** (`closesTaskNoticeWithoutTurn` in `session/agents/claude/task-notice.ts`,
`ClaudeAdapter.dropsStaleNoticeResult` in `adapter.ts`): the adapter drops a successful zero-turn
result whose origin is a task notification, from the spawn until the CLI first
shows work on the spawn prompt — a replay, assistant output, or any other
result. The `agent_self_wake` for the notice is still forwarded, so a
backgrounded subagent's card still retires.

Two bounds on that rule, both deliberate:

- **Only before the spawn prompt's turn shows.** In that window every layer
  already counts the prompt's turn as running, so the notice began no turn in
  anyone's books and nothing waits on its result. Later is different: a notice
  on an idle resident process makes the worker and the orchestrator mark the
  session busy, and only a result clears that. Dropping one there would wedge the
  session, which is §7's bare-`init` hazard again.
- **Only the shape the CLI names.** A zero-turn result is also how the CLI
  answers a command itself (`/goal`, docs/297), and a failed result must always
  be seen. Neither is dropped: the test is all of `subtype: "success"`,
  `is_error` not true, `num_turns: 0` and the `task-notification` origin.

**A second reader of the same stream.** `runClaudeGoalControl` (`claude-goal.ts`)
resumes the conversation in a process of its own and took the first `result` as
the command's answer. On a conversation in this state that is the notice's empty
result, so the first goal read failed with an empty message, and the second
succeeded because the first one had spent the notice. Measured on the same CLI,
the command's own result follows and is told apart by shape — it carries
`local_command: "goal"` and no `origin`:

```
 1165ms  system/task_notification  status:"stopped"
 1936ms  system/init
 1937ms  result/success            num_turns:0, result:"", origin:{kind:"task-notification"}
 1948ms  system/init
 1948ms  assistant (synthetic)     "No goal set. Usage: `/goal <condition>`"
 1949ms  result/success            num_turns:0, result:"No goal set. …", local_command:"goal"
```

The control process now skips a result that matches the same predicate and reads
on. It needs no window of its own: the process exists for one command, and a
notice's result is never that command's answer. What it cannot change is that
the read still spends the notice, so the session's next turn is not told about
the job.

Coverage: `adapter.test.ts` → "a task notice left by the previous process";
`claude-goal.test.ts` → "on a thread whose previous process left a background job".

### 9. Tell the agent when a one-shot process stops its jobs

Probe A and §7 agree that a one-shot CLI leaves "nothing to wake". That is correct for
the container, and it left the *agent* with no signal. The agent cannot see which kind
of process its turn runs on, and when this was written every turn that ShipIt starts was
one-shot (`docs/287-consult-result-delivery/plan.md` §1). Since
`docs/329-user-steers-every-turn` a turn that ShipIt starts for work runs on the process a
typed turn would run on, so this section applies where that process is one-shot: Live
steering off, or a harness that cannot hold a process. So an agent that ended a message to
wait for a `run_in_background` build — a pattern that works on a turn the user typed —
lost the build about 5 s later, got no notice, and was never started again. In
production a session stayed idle for 9 h 13 min this way, on the second link of a
`notify-on-merge --self` chain; the same path is every link after the first.

**What the CLI does, measured on 2.1.284** with the exact one-shot invocation
(`--print --input-format stream-json`, stdin closed after the prompt):

```
 2938ms  system/background_tasks_changed  tasks=[{task_id, task_type:"local_bash", description}]
 4820ms  result/success
 9862ms  system/background_tasks_changed  tasks=[]
 9862ms  system/task_updated              patch:{status:"killed"}
 9862ms  system/task_notification         status:"stopped"
 9889ms  CLI PROCESS EXITED code=0        (the job's output file was never written)
```

Two more facts from the same probes:

- A job that **ends inside the 5 s window** is not lost. The CLI reports
  `task_notification status:"completed"`, emits a new `system/init`, runs a turn of its
  own, and exits after that turn's `result`.
- `description` is the Bash call's own `description` when the agent gave one, and the
  command only when it did not. So the text does not identify a command.

**The CLI's own notice is not enough.** §8 shows that the next process to resume the
conversation tells the model that the job did not finish. That notice needs a next turn,
and on this path none came: the session waited for a user who came back 9 h later. The
wake of this section is that next turn, so its model reads the CLI's notice and the wake
prompt together. The notice's zero-turn result is dropped by the adapter (§8), so it
does not reach the executor as an `agent_result` and takes no reading of the task list;
its `task_notification` has `status: "stopped"`, so it removes no job from one either.

**The mechanism.** On a non-streaming turn, `turn-executor` keeps the task list the CLI
reports and takes a reading of it at each `agent_result`. A `completed` notification
removes that job from the reading, and the result of the CLI's own follow-up turn takes
the reading again. What is left when `done` arrives is the set of jobs the CLI stopped.
(On this path the stop is certain; the prompt's wording allows for the path below.)
The executor passes their descriptions to `reportStoppedBackgroundJobs`
(`services/stopped-background-jobs.ts`) as the **last** thing the `done` handler does —
in its `finally`, so that a throw earlier in the sequence cannot skip it, and after the
commit, the idle signal and the settlement, because the report can start a turn. The
call is a no-op unless a non-streaming turn had a result, which is what keeps the early
returns of that handler out of it. It also runs after the post-turn hold is released,
and not inside it as `runQuotaContinuation` does on the streaming path: a step before
the release moves this executor's `endPostTurnWork` later, and a late `end()` of an
expired lease consumes the lease a rebase driver took in between (planning#556;
`rebase-driver.test.ts` went red on exactly that). The wake needs no lease of its own, because `wakeSessionWithTurn`
resumes a session whose runner was disposed. The executor's own maps are used rather
than `runner.backgroundTaskDescriptions`, which is gated to zero off a resident process
by design (the liveness gate above).

The service then does one of four things:

| Case | What happens |
|---|---|
| The ordinary case | `wakeSessionWithTurn` starts a system turn whose prompt (`prompts/stopped-background-jobs-wake.md`) names the jobs. If that turn never reaches the agent, the prompt is parked as a pending agent notice. |
| The turn that ended **was this wake** | No second wake. The prompt is parked as a pending agent notice for the next turn, and the transcript gets a `warn` notice for the user. This is what stops a loop when the agent backgrounds a job again. |
| A `shipit agent run` consult is in flight | No wake. The prompt is parked, and it rides the turn that the consult's result starts (docs/287-consult-result-delivery). One of the jobs is then likely the consult's own local command, and the description cannot say which, so the prompt carries a sentence that a consult must not be run again. |
| The process was **displaced** (`mayWake: false`, below) | No wake. The prompt is parked and the user gets the `warn` notice. With a consult in flight the row above applies first, so there is no notice. |

The wake recognises its own turn by the **delivery id** it dispatched with
(`stopped-background-jobs:<uuid>`), which the executor passes back with the report. A
delivery id is persisted to the worker and to a held turn, so the guard also holds across
an orchestrator restart and a docs/322 answer hold, with no state in the service.

**The executor can lose the process before its `done`.** Another turn can take the
runner in the 5 s after the result: a queued one, which the one-shot path starts at
`agent_result`, or a new message. Its agent takes the runner's slot, the runner emits
`superseded` on the old one, and a container runner drops the old process's later events
at its run-token guard — `done` included. A credential change, a spawn-identity change
and an account failover retire a process the same way. So the `superseded` handler
reports too, from the reading taken at the result. That is the process's one report:
the report empties the reading, and a displaced process takes no new one. The second
half matters on the local runner, which has no such guard and still delivers the later
events of a process it displaced — a job that ends, the turn the CLI runs for it, and
that turn's result, which would otherwise fill the reading again for `done` to report
with leave to start a turn. Two things are different on this path:

- **The report starts no turn.** A one-shot turn commits in `done`, or before the drain
  when the queue is not empty. A process retired with an empty queue — a credential
  change does that — has committed nothing, and its `done` never comes: the `superseded`
  handler releases its commit hold without a commit, and the displacing turn's own
  commit is the only one its work gets. So the executor passes `mayWake: false` at every
  displacement, and the service parks the note. A wake that only "queues behind the
  displacing turn" was tried and taken out, because a displacing turn that fails during
  the wake's preparation let the wake start on uncommitted work. Since
  docs/240-unlosable-turn-dispatch Fix G that holds only for one way of failing. A
  displacing turn that fails inside the executor holds its commit hold until the commit
  of the whole tree settles, and `dispatchOnRunner` queues the wake behind it. A turn that
  fails in setup, before the executor takes the hold (the catch in `dispatchOnRunner`, or
  an interactive turn whose composition throws), commits nothing and holds nothing, so a
  wake would still start on the displaced process's uncommitted work. That case keeps
  this rule. Where the parked note lands depends on the
  turn that displaced the process. An interactive turn installs its agent before it reads
  the pending notice (`ws-handlers/agent-execution.ts`), so it carries the note itself.
  A dispatched turn composed its prefix first, so the note rides the turn after it.
- **The job's end is not known.** Displacement is not the end of the process. A job can
  still end in the seconds that are left, and those events are dropped. This is why the
  prompt says the work "most probably did not finish" and tells the agent to check what
  it wrote, on both paths, and does not say that it was stopped.

A turn the user stopped is not reported. The executor reads the user's Stop record
(`stoppedByUser`, which the Stop button and a force-kill set and a question's own
interrupt does not) where the process ends. That alone is not enough: a stopped process
still sends its `task_notification`, `agent-listeners` adopts it as a turn, and the
`running` false → true of that adoption starts a new record. So a listener registered
*before* `wireAgentListeners` latches the Stop on every event of a non-streaming
process, the way the `error` listener beside it does for the last error. The record
belongs to the runner's current turn, not to a process, which leaves the two cases
under Residuals.

A wake that was admitted can still fail before the agent reads it (no credential is
free at env preparation, the runner is disposed). The prompt is then parked for the next
turn. This rule is wider than `shouldRepark`, which leaves a plain `errored` alone so
that work is not repeated: this note only informs, so a repeat costs little and a loss
leaves the agent waiting. It is `informingWakeMissed` in `turn-settlement.ts`, which the
finished-consult wake shares (`docs/287-consult-result-delivery`).

**The agent is also told before it makes the mistake.** `dispatched-turn.ts` puts
`prompts/one-shot-turn-note.md` in the prompt prefix of every turn that ShipIt started
and that will run on a one-shot process (`docs/329-user-steers-every-turn`), except
compaction and a driver-owned turn (`postTurn: "none"`, whose prompt is the driver's
script; the pending notice and the status card stay off it too), for a harness with
`startsOwnTurns` (the only kind whose agent has a reason to end a message and wait). `/shipit-docs/environment.md` and the `notify-on-merge`
chain section of `/shipit-docs/sessions.md` state the same rule.

**Not done, on purpose.**

- *Keeping the process alive until the jobs end.* The one-shot process is the streaming
  invocation with stdin closed, so holding stdin open would do it. But a one-shot turn
  drains the queue at `agent_result` and commits in `done` (before the drain only when
  the queue is not empty): a held process would delay the commit for the length of the
  job and let a drained successor run beside a live predecessor. §7's first gate exists
  to keep those two apart.
- *Running system turns on a resident process.* Ruled out at the time for the reasons in
  `docs/287-consult-result-delivery/requirements.md` (resolved 2026-09-03), and reversed on
  2026-10-12 (`docs/329-user-steers-every-turn` req 1). It would also
  leave a user-typed turn uncovered when `advanced.liveSteering` is off, which is one-shot
  too; the report covers both because it keys on the process, not on who started the turn.

**Residuals.**

- The one-shot note rides turns that ShipIt started only; a user-typed one-shot turn (live
  steering off) gets the wake but not the note.
- A displaced process gets no wake. When a dispatched turn displaced it, the note waits
  for the turn after that one, and the user's notice is the only prompt for it.
- A parked note is the session's pending agent notice, which it shares. A branch sync and
  a manual reset replace that whole field on purpose (`setPendingAgentNotice`: branch
  movement supersedes earlier notices), so a parked note that no turn has read is lost
  then. The user's transcript notice is not.
- The Stop record is per turn. A Stop on this process is missed when another turn claims
  the runner before this process sends one more event, and the report then leaves a
  note. A Stop on a successor that is still in setup when it displaces this process
  drops this process's report.
- A wake does not wait for work that no commit covers. Since
  docs/240-unlosable-turn-dispatch Fix G, `runner.dispatch` queues every wake while
  `runner.turnCommitPending` is set, and the executor releases the queue when its local
  commit settles or its hold expires, so a wake no longer starts while a *later* turn
  that failed is still committing. Two cases stay open: a turn that failed in setup
  never takes the hold and commits nothing (the displacement rule above), and once the
  hold's 120 s deadline has passed the gate is open again.
- The consult gate reads `subAgentSpawnsInFlight`, which drops when the worker's spawn
  returns — before the consult's result is delivered. A consult that ends in the few
  seconds between the turn's result and the report is therefore not counted, and the
  session gets both turns. The second one costs a turn and loses nothing; the opposite
  error (park, with no turn coming) would be the silent wait this section removes.
- An auth-heal or quota retry runs the prompt again on a new process and a new executor.
  Jobs the first process started are not carried into the new executor's reading.
- A turn adopted after an orchestrator restart did not see the task list from before the
  restart, so a job started before it is not reported. The wake's `onSettled` is an
  in-memory callback, so a wake that fails after a restart parks nothing.
- A resident process that *dies* with jobs outstanding (a crash, an OOM kill) is a
  different event and still tells nobody.

Guards: `turn-self-wake-commit.test.ts` → "background jobs a one-shot process stops at
its exit" (each case verified red with its line removed), `services/stopped-background-jobs.test.ts`,
`dispatched-turn-one-shot-note.test.ts`.

## Bounds — what this does not do

A self-wake still cannot resurrect a container that has *already* been destroyed;
this only prevents destroying one that is (or is about to be) doing work. The
in-container guidance in `src/server/shipit-docs/environment.md:121` stands:
runtime timers are not durable, and work that must survive belongs in a compose
service or `agent.install`. This narrows the race; it does not make backgrounded
shell work a supported persistence primitive.

## Key files

- `src/server/orchestrator/turn-executor.ts` — `rearmForCliStartedTurn` (§7) and
  the post-turn guards it re-arms
- `src/server/orchestrator/turn-self-wake-commit.test.ts` — §7's and §9's regression tests
- `src/server/orchestrator/services/stopped-background-jobs.ts` — §9: the wake, the
  loop guard and the parked note
- `src/server/orchestrator/prompts/stopped-background-jobs-wake.md`,
  `prompts/one-shot-turn-note.md` — §9's two prompt texts
- `src/server/orchestrator/dispatched-turn.ts` — puts the one-shot note on a system turn
- `src/server/orchestrator/idle-enforcer.ts` — count-based idle eviction
- `src/server/orchestrator/tier-escalation.ts` — 24h/2d/14d disk ladder
- `src/server/session/agents/claude/process.ts` — `StreamingClaudeProcess`
- `src/server/session/agents/claude/adapter.ts` — `mapEvent`
- `src/server/shared/types/claude-types.ts` — `ClaudeSystemEvent`
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — runner state writes
- `src/server/orchestrator/session-runner.ts` — runner interface
- `src/server/orchestrator/ws-handlers/send-message.ts:124` — the queue/steer
  branch that forbids overloading `running`
- `src/server/orchestrator/route-registry.ts:101` — authoritative reconnect
  snapshots (`active_runners`, `session_attention`)
- `src/server/shared/types/ws-server-messages/session.ts` — `WsSessionStatus`
  (turn transitions only) and `WsBackgroundTasks` (the task-list level signal)
- `src/server/orchestrator/api-routes-session-spawn.ts` — `GET /history`, which
  carries `backgroundTasks` alongside `agentRunning`
- `src/client/utils/session-data.ts` — `loadSessionHistory`, where the status
  line is re-established on switch / reload
- `src/client/hooks/message-handlers/background-tasks.ts` — the task-list handler
  and the status-line label
- `src/client/components/SessionSidebar/SessionStatusIndicators.tsx` — status dot
- `src/client/hooks/useAttentionInfo.ts` — `computeAttentionReason`
- `src/client/hooks/useAttentionNotifications.ts` — the settle window before a
  reason is worth interrupting the user for

**5h. The runner announces the marker; exactly one subscriber broadcasts it.**
Added by planning#246 after the cross-backend review enumerated the clears 5b's
per-call-site broadcasts did not cover — a spawn-identity change and a
credential rotation (`resident-spawn-guard`), the stuck-running reconciler
(`verifyRunningState`), and both runners' `dispose`. Each one clears the tracker
directly and emits no draining event, so each left the sidebar dot lit on a
session with nothing running until the next SSE connect.

Adding a broadcast to each was the wrong shape: the marker's inputs are mutated
from a dozen places (`setBackgroundTasks`, `clearBackgroundTasks`, the
`isStreamingActive` gate, consult registration, `dispose`), and any future sixth
one would be silent again by default. So the announcement moves to the one place
that can see every mutation. The runner emits `background_work` whenever
`backgroundWorkDescriptions` actually changes, and a single subscriber wired in
`runner-registry-factory`'s `onRunnerCreated` turns it into the
`session_attention` SSE broadcast.

This *removes* mechanism rather than adding it: the explicit broadcasts in
`turn-executor`, `agent-listeners`, and `services/sub-agent.ts` are all gone,
along with the service's `sseBroadcast` dependency and its route wiring. It also
makes the guarantee structural — a new way to clear the tracker is announced
because it goes through the same setters, not because someone remembered.

The emit is deduped on the rendered value. `isStreamingActive` is set at both
ends of every turn and a clear on an already-empty tracker is the common case,
so a bare pass-through would spend an SSE frame per browser saying nothing.
Convergence after a genuinely missed frame stays the connect snapshot's job.

**5i. `background_tasks` is not replayed on reattach.** The same review noted
that WS, SSE, and `GET /history` all write this marker with no shared ordering,
and proposed a per-session revision. That is more mechanism than the exposure
warrants — each transport preserves its own order, the updates are
level-triggered re-statements rather than deltas, and the connect snapshot
reconciles wholesale. But one concrete instance was worth closing: the
turn-event replay buffer holds the last `background_tasks`, and the clears that
announce over SSE alone (a crashed process, a disposed runner) leave that copy
saying "outstanding" after the truth became "none". Replaying it on reattach
resurrected the dot, and which value won depended on whether the replay landed
before or after the HTTP history it contradicts.

`background_tasks` therefore joins the replay loop's existing skip list in
`route-registry.ts`, beside `agent_event` and `turn_snapshot`. The attach's own
`GET /history` carries the runner's current `backgroundTasks` read live at
request time, so history is the single attach-time source and there is no race
left to lose.

**The expiry is announced (planning#710).** The decay first worked through the
getter alone, with no mutation to announce, so an open chat kept "Waiting for:
…" after the tracker had stopped honoring it. `BackgroundTaskTracker` now keeps
one timer, armed only while its list is not empty and restarted by each list
update. At the TTL it calls the runner, which clears the list through
`clearBackgroundTasks()` — the same path a kill site takes. A clear that drops
a list sends the WS `background_tasks` message (with the consults that still
run, else count 0) as well as the SSE announcement, because `session_attention`
updates the sidebar and not the open chat's row; `clearResidentProcessState`
already did this. The announcement also releases a turn queued behind the work,
which the getter alone never did.

A streaming turn that starts on a new process clears the list first
(`executeAgentTurn`, unless it reuses the resident or adopts a turn; a one-shot
turn already counts no tasks). Several
paths kill a resident and drop it from the slot without clearing its list — a
quota or account failover, a credential change, an answer that replaces a
one-shot process — and the new turn's `isStreamingActive = true` made the dead
process's tasks count again.
