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
readonly backgroundTaskCount: number;   // last background_tasks_changed
readonly agentBusy: boolean;            // running || backgroundTaskCount > 0
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
is no heartbeat. There is also no pull API: the `TaskList` / `TaskGet` /
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
   `runner.isStreamingActive`.
2. **Gate the count on process liveness.** Because a task cannot outlive the
   process, `backgroundTaskCount > 0` is only meaningful while the streaming
   process is alive. Make the getter return 0 unless `isStreamingActive` — that
   is free, and it collapses the largest drift window (process died, drain event
   never arrived) into a correct answer.

**Residual gap, handled by decay.** A dropped SSE frame while the process stays
alive is still possible. Treat the count as a bounded-lifetime *hint*: record
`backgroundTasksSeenAt` alongside it and honor a non-zero count for at most one
`IDLE_GRACE_PERIOD_MS` window. A missed drain event then costs one grace period
of extra container lifetime and never a permanent leak. The decay deliberately
errs toward *reclaimable*, which is the safe direction for a resource guard.

An orchestrator restart loses the count entirely (it is in-memory runner state).
On the **deploy path this cannot desync**: `deployment/vps/deploy.sh:26` force-
removes every container labeled `shipit-stack=shipit` — which session containers
carry (`session-container.ts:498`) — before the orchestrator comes back, so the
CLI processes and their background tasks die with the containers. A zero count
after the restart is then simply correct.

The only residual case is a **crash restart**, where `rediscover`
(`app-lifecycle.ts:201`) re-adopts surviving containers whose CLI process still
holds tasks, while the rebuilt runner reports a zero count. Accepted, not fixed:
reconstructing it would mean reading the CLI's undocumented per-session `tasks/`
directory inside the container (observed at
`/tmp/claude-<uid>/<cwd-slug>/<session-id>/tasks/<task-id>.output`), an internal
path with no compatibility guarantee — not worth the coupling for a window this
narrow, which additionally only bites if that session is among the excess idle
set or the host is under memory pressure.

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
when this shipped; docs/140 Phase 6.11 added a second edge, a post-`result`
`agent_init`, and renamed it).

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
- `src/server/orchestrator/turn-self-wake-commit.test.ts` — §7's regression tests
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

**Residual, accepted.** `BackgroundTaskTracker` decays a non-zero count after
its TTL through the getter alone, with no mutation to announce. A marker can
therefore outlive the tracker's own honoring of it by up to one window in a
browser that stays connected. The decay only fires when events stopped arriving
entirely — the liveness gate catches the ordinary process-death case first — and
the connect snapshot corrects it.
