---
title: Native goal command (CLI-backed)
description: "`/goal` in chat, backed by Codex's own `thread/goal/*` JSON-RPC API: set, show, pause, resume and clear a goal, with an always-visible goal chip."
issue: planning#31
---

# Native goal command (CLI-backed)

Requirements: [requirements.md](requirements.md). Remaining work: [checklist.md](checklist.md).

## Problem

ShipIt supports `/goal …` in chat: set a long-running objective, see it,
pause or resume it, and clear it (req 3). Rather than a ShipIt-managed
substrate that re-implements goal state (the rejected
[docs/153](../153-goal-command/plan.md) design), this adapts the goal feature
the Codex CLI ships natively. The CLI owns persistence, budget tracking and
the model-side goal tools (`create_goal`, `update_goal`, `get_goal`); ShipIt
is a thin transport and rendering layer. This is the
[docs/132](../132-slash-commands/plan.md) Bucket-4 command `/goal`.

The incident that made this urgent: goal mode is on by default in the pinned
Codex, and a model created a goal with `create_goal` that the user could not
see or clear. ShipIt logged `thread/goal/updated` and did nothing else,
resumed the same thread (and so the same goal) every turn, and sent a typed
`/goal clear` to the model as plain text.

## Backend support

| Backend | Native goal surface | ShipIt |
|---|---|---|
| **Codex CLI** (pinned 0.154.0) | `thread/goal/*` JSON-RPC, on by default | Supported — the full vocabulary |
| **Claude Code CLI** (pinned 2.1.260) | `/goal`, handled locally by the CLI (Stop-hook-backed). `/goal <condition>`, `/goal clear` and a status read; no pause, no resume | Supported — [docs/297](../297-goal-on-claude/plan.md) |
| **Grok** (Build 1.0.18) | `/goal <objective>\|status\|pause\|resume\|clear`, handled locally by the CLI | Supported — [docs/298](../298-goal-on-grok/plan.md); `set` and `resume` ride a turn because they run the agent |
| **OpenCode** (1.18.27) | None | Not offered |

"Handled locally by the CLI" means the command never becomes a model call: it
works in ShipIt's own transport, and the goal it sets persists in the CLI's
store across ShipIt's per-turn spawns exactly as Codex's thread goal does.

Interception is capability-gated, so on a harness ShipIt does not support
`/goal …` is not intercepted and is sent as an ordinary prompt (req 5) — which,
on a CLI that has its own `/goal`, sets a real goal that steers every later turn
while ShipIt shows no chip. That was the state of every Claude session before
docs/297. `AgentCapabilities.goalActions` refines the gate per action, because a
harness can support an action the CLI must run inside a turn (docs/297).

## Measured on codex-cli 0.154.0

Probed on 2026-09-11 against the pinned binary with a scratch `CODEX_HOME`
and no credentials (`codex app-server generate-json-schema` for the shapes,
then a live app-server over stdio). The docs/153 notes were from pre-stable
builds; these supersede them.

| Question | Answer |
|---|---|
| Request shapes | `thread/goal/get {threadId}` → `{goal: ThreadGoal \| null}`; `thread/goal/set {threadId, objective?, status?, tokenBudget?}` → `{goal}`; `thread/goal/clear {threadId}` → `{cleared: boolean}` |
| Notifications | `thread/goal/updated {threadId, turnId: string \| null, goal}`; `thread/goal/cleared {threadId}` |
| `ThreadGoal` | `threadId, objective, status, tokenBudget (nullable), tokensUsed, timeUsedSeconds, createdAt, updatedAt` (seconds) |
| Status values | `active, paused, blocked, usageLimited, budgetLimited, complete` |
| Needs `experimentalApi` or `--enable goals`? | No — the requests are in the default schema and accepted without either |
| Needs auth? | No — goal requests never reach the model |
| On an unloaded thread (no `thread/resume`) | get/set/clear all work, and no turn starts |
| `set` with `status: active` on a **loaded, idle** thread | Codex starts a continuation turn at once |
| `thread/resume` of a thread with an **active** goal | Codex re-emits `thread/goal/updated`, then starts a continuation turn by itself |
| `thread/resume` with a **paused** goal | Re-emits `thread/goal/updated`; no turn |
| `turn/start` sent right after such a resume | Returns the id of Codex's **self-started continuation turn**. Sent at once (ShipIt's order), the user's message is added into that turn; sent 300 ms later, it did not appear in it |
| Same resume under `-c features.goals=false` | No self-started turn — but every `thread/goal/*` request fails with `goals feature is disabled` |
| Pause on the unloaded thread → resume → `turn/start` → set `active` while the turn runs | No self-started turn; the user's message gets its own turn; re-activating starts no extra turn |
| `set status: paused` while a turn runs | Accepted; the running turn is not interrupted |
| Unknown thread id | JSON-RPC error `-32600 thread not found: <id>` |

## Design

### Adapter (session side)

- `codex/codex-goal.ts` — `executeGoalCommand` maps a command to the RPCs
  above: `get` → `thread/goal/get`; `set` → `thread/goal/set` with
  `status: "active"`; `clear` → `thread/goal/clear`; `pause`/`resume` →
  `get` first (a status-only set has nothing to update without a goal), then
  `thread/goal/set {status}`.
- `CodexAdapter.goalCommand(threadId, command)` — during a turn it uses the
  live app-server. Between turns there is no process (ShipIt ends it at
  `turn/completed`), so `runCodexGoalControl` starts a short-lived
  `codex app-server` with the same `HOME`/`CODEX_HOME` a turn would use,
  runs `initialize` and the goal request, and ends the process tree (15 s
  limit). It never calls `thread/resume`, because that would start a
  continuation turn; goal requests on an unloaded thread start nothing.
- If the turn ends in the middle of a live command (pause and resume are two
  requests), a request written after the process is gone is refused rather
  than left waiting, and the whole command runs again in a control process.
  Every command is safe to repeat.
- `CodexEventHandler` — `thread/goal/updated` and `thread/goal/cleared` on the
  parent thread become an `agent_goal_updated` event (`goal: null` for
  cleared). Subagent threads are ignored.
- **Resume hold.** Resuming a thread whose goal is `active` makes Codex
  start its own continuation turn before ShipIt's `turn/start`, and the
  user's message is folded into it (measured). So before `thread/resume` the
  handler reads the goal on the still-unloaded thread (no turn starts) and,
  **only if it is `active`**, pauses it; after `turn/start` (or
  `thread/compact/start`) it sets it active again. A goal the user paused,
  or one that is complete or limited, is never touched, so ShipIt never
  re-activates a goal the user paused. Codex's own notifications during the
  hold are not reported, so the chip never flickers to "paused".
- **Failure between the two steps: restore.** The restore runs in a
  `finally`, so a failed `turn/start` restores the goal too. If the process
  died in between, the live request is refused and the restore runs in a
  control process (setting a goal active on an unloaded thread starts no
  turn). For that, the adapter now rejects requests still pending when its
  process exits; the start-up error is only logged, because the exit already
  reported the run's end. If the whole container dies inside the window of a
  few milliseconds, the goal stays paused; the next turn's read reports it
  as paused, so the chip and `sessions.agent_goal` show it and `/goal resume`
  restores it.
- Rehydrate (req 6) — the same pre-resume read is reported, including "no
  goal", so the chip is right from the start of every resumed turn. A new
  thread reports `goal: null` without asking.

### Transport

- `AgentProcess.goalCommand?` (optional) and `AgentCapabilities.supportsGoals?`
  (absent is false), published to the client on `agent_list`, alongside
  `goalActions` (docs/297).
- Container mode: `ProxyAgentProcess.goalCommand` →
  `ContainerSessionRunner.goalCommandOnWorker` → worker `POST /agent/goal
  {agentId, threadId, command}`. The worker uses the live agent when it is
  the same agent and otherwise builds a fresh adapter from its factory, whose
  `goalCommand` runs the control process. The route is in `LIFECYCLE_PATHS`,
  so it needs the worker token even on loopback — the agent in the container
  cannot clear its own goal through it. The orchestrator waits 30 s, longer
  than the control process's 15 s, so a late success is never reported as a
  failure.
- **Older workers.** The route is additive. A container still on an image
  from before this change answers 404; the user sees "this session's
  container predates goal support", and goals behave as before (not shown)
  until ShipIt replaces the container, which it does for containers left on
  an old image. No capability negotiation: the window is transient and no
  worse than today.
- Local mode: the orchestrator's own adapter (from `runner.createAgent`)
  does the same in-process.

### Orchestrator

- `send-message.ts` parses `/goal`, `/goal status`, `/goal clear`,
  `/goal pause`, `/goal resume` and `/goal <objective>`
  (`shared/goal-command.ts`) and, when the active agent `supportsGoals`,
  hands it to `ws-handlers/goal-command.ts` and returns: no turn, no queue,
  no prompt (req 4). The check runs before the auth gate — reading or
  clearing a goal must not need a runnable credential. The thread is the
  session's `agentSessionId`; with none yet, the user is told to send a first
  message. A frame whose `sessionId` is not the socket's own session is
  ignored: the runner, agent and home all belong to the socket's session.
- The answer is a persisted `system_notice` (`emitNoticeInTurn` /
  `emitNoticePostTurn`), e.g. "Goal cleared.", "Goal (active): …". The
  command has no bubble, so the notice is its trace in the transcript.
- Goal operations on one session run one at a time (`runGoalExclusive`), so a
  slow answer cannot overwrite a newer one, and an answer about a thread the
  session no longer uses (conversation reset meanwhile) is dropped.
- Every goal the CLI reports — from a command, from a notification during a
  turn (the `create_goal` case, req 1), or from rehydrate — goes through
  `recordAgentGoal`, which stores it in the new `sessions.agent_goal` column
  and broadcasts `session_list` when what the chip shows (objective, status,
  budget) changed. Usage-only updates are not written. A stored JSON `null`
  means "read, no goal"; SQL NULL means "never read". Clearing the
  conversation (`clearAgentSessionId`) also clears the goal.
- **Read on open (req 6).** When a session is opened and its goal was never
  read — a session from before this feature, like the incident's — the goal
  is read once through the same `goalCommand` path, without a turn. Best
  effort: if the container is not up yet, the next open or turn does it.

### Client

- `SessionInfo.agentGoal` drives `GoalChip`, shown above the composer while
  the session has a goal and the active agent supports goals. It names the
  status and objective and says how to remove it (`/goal clear`); it has no
  button (CLAUDE.md §5 — the command is the control). Because it reads the
  session record, it is right after a reload, a session switch and an
  orchestrator restart (req 6).
- The `/` menu lists `/goal`, `/goal clear`, `/goal pause`, `/goal resume`
  only for a goal-capable agent (req 5).
- `runSend` sends a goal command as a bare `send_message` with no optimistic
  bubble and no spinner, since no turn will follow.

## Continuation (req 8)

**Decision: keep ShipIt's one-process-per-turn lifecycle; no keep-alive in
this change.** Codex's goal loop continues by starting a new turn on an idle
thread. ShipIt ends the app-server at `turn/completed`, so that loop never
runs between user turns, and a goal does not keep the agent working on its
own. What the goal still does:

- It persists in Codex's store and rides every resumed turn (Codex puts an
  active goal in front of the model), so it steers each turn the user starts.
- Codex updates its status (`complete`, `budgetLimited`, …) during those
  turns, and the chip follows.
- It is always visible and always clearable (reqs 1–2), which was the
  production gap.

**Resume continuation (measured 2026-09-11).** Resuming a thread whose goal
is active makes Codex start its own continuation turn before ShipIt's
`turn/start`, which folds the user's message into a goal-continuation turn —
the loop in the incident. The resume hold (see "Adapter") prevents it. A
`features.goals=false` override also prevents it, but it disables every
`thread/goal/*` request, so it cannot coexist with this feature.

A pause sent during a running turn does not interrupt that turn (measured);
the notice says so ("The running turn continues; the pause applies from the
next turn").

Automatic continuation needs the process to outlive the turn, and that
touches the post-turn flow (auto-commit, push, queue drain run on `done`),
between-turn message delivery (`turn/start` instead of `turn/steer`), idle
disposal and crash recovery. docs/153 "Process lifetime" is the analysis of
that work. It is a follow-up, not part of this change.

Req 7 (goal mode on only when ShipIt can show and control it) and merge
order: PR #2725 turns goal mode off (`features.goals=false`) as the immediate
stop and merges first. This change removes that override once #2725 is on
`main`, which turns goal mode back on with the goal shown, controllable, and
held across every resume.

## Relationship to docs/153

[docs/153](../153-goal-command/plan.md) is the **rejected** ShipIt-managed
substrate design. It stays as reference, mainly for its keep-alive analysis,
which the continuation follow-up above would build on.

## Key files

- `src/server/session/agents/codex/codex-goal.ts` — RPC mapping and the control process.
- `src/server/session/agents/codex/codex-event-handler.ts` — notifications and rehydrate.
- `src/server/session/agents/codex/adapter.ts` — `goalCommand`, `supportsGoals`.
- `src/server/session/agent-controller.ts` — worker `POST /agent/goal`.
- `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts` — the container hop.
- `src/server/shared/goal-command.ts` — `/goal` parser (shared with the client).
- `src/server/orchestrator/ws-handlers/goal-command.ts`, `send-message.ts` — interception.
- `src/server/orchestrator/services/agent-goal.ts` — persist + broadcast, notice text.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts` — `agent_goal` column.
- `src/server/shared/types/agent-types.ts` — `AgentGoal`, `AgentGoalCommand`, `agent_goal_updated`, `supportsGoals`.
- `src/client/components/GoalChip.tsx`, `MessageInput/MessageInput.tsx`, `utils/send-handler.ts`.
