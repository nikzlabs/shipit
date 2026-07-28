---
issue: https://linear.app/shipit-ai/issue/SHI-244
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
still attached when the self-wake fires. The wake turn's `agent_assistant` /
`agent_result` events run through a closure holding the **prior** turn's captured
`capturedSessionId` / turn state, and the terminal `agent_result` re-runs the
post-turn flow (`postTurnCommit` → `scheduleAutoPush` → PR card) attributed to
that stale turn. So the events are not merely unnoticed — they are mis-filed.

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

**5a. Live push.** Extend `WsSessionStatus` (`ws-server-messages/session.ts:70`)
with `backgroundTasks?: { count: number; descriptions: string[] }`, emitted on
each `agent_background_tasks`. `descriptions` comes straight from the CLI's task
list and is what makes the tooltip specific ("`npm test` running") instead of a
bare count.

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

**5c. Sidebar.** `SessionStatusDot`
(`SessionSidebar/SessionStatusIndicators.tsx`) gains a rung between "agent
running" (priority 2) and "CI failed" (priority 3). It must **not** reuse the
pulsing green `bg-(--color-success)` dot: that means "the agent is thinking," and
here the agent is specifically *not* thinking — it is waiting on a task that will
wake it. A distinct Phosphor glyph at `ICON_SIZE.XS` in the neutral/secondary
color, `title={`${count} background task${count === 1 ? "" : "s"} running`}`,
reads as "work outstanding" without claiming the agent is live.

**5d. Attention.** `computeAttentionReason` (`useAttentionInfo.ts`) currently
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

### 6. Fix the stale-listener attribution

Independently of the liveness fix: detach the turn's listeners on `result` for a
resident streaming process, and re-wire per turn, so a self-woken turn is not
attributed to the previous turn's captured context. Without this, marking the
runner busy keeps the container alive to do post-turn work under the wrong
session id.

## Bounds — what this does not do

A self-wake still cannot resurrect a container that has *already* been destroyed;
this only prevents destroying one that is (or is about to be) doing work. The
in-container guidance in `src/server/shipit-docs/environment.md:121` stands:
runtime timers are not durable, and work that must survive belongs in a compose
service or `agent.install`. This narrows the race; it does not make backgrounded
shell work a supported persistence primitive.

## Key files

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
- `src/client/components/SessionSidebar/SessionStatusIndicators.tsx` — status dot
- `src/client/hooks/useAttentionInfo.ts` — `computeAttentionReason`
