---
title: Native goal command (CLI-backed)
description: "`/goal` in chat, backed by Codex's own `thread/goal/*` JSON-RPC API: set, show, pause, resume and clear a goal, with an always-visible goal chip. Claude has no programmatic surface yet."
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

| Backend | Native goal API | ShipIt |
|---|---|---|
| **Codex CLI** (pinned 0.154.0) | Yes — `thread/goal/*` JSON-RPC, on by default | Supported (`supportsGoals: true`) |
| **Claude Code CLI** | No programmatic surface (TUI-only, Stop-hook-backed) | Not offered |
| **OpenCode, Grok** | None used | Not offered |

On an agent without `supportsGoals`, `/goal …` is not intercepted and is sent
as an ordinary prompt, exactly as before (req 5). If Claude later ships an
API, it needs only a `goalCommand` implementation on its adapter.

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
| `turn/start` sent right after such a resume | Accepted; it becomes the turn (same id as `turn/started`), no collision |
| `set status: paused` while a turn runs | Accepted; the running turn is not interrupted |
| Unknown thread id | JSON-RPC error `-32600 thread not found: <id>` |

## Design

### Adapter (session side)

- `codex/codex-goal.ts` — `executeGoalCommand` maps a command to the RPCs
  above: `get` → `thread/goal/get`; `set` → `thread/goal/set` with
  `status: "active"`; `clear` → `thread/goal/clear`; `pause`/`resume` →
  `get` first (a status-only set has nothing to update without a goal), then
  `thread/goal/set {status}`. Responses are read as `{goal}` or a bare goal,
  the same defensive double-read the adapter uses for thread and turn ids.
- `CodexAdapter.goalCommand(threadId, command)` — during a turn it uses the
  live app-server. Between turns there is no process (ShipIt ends it at
  `turn/completed`), so `runCodexGoalControl` starts a short-lived
  `codex app-server` with the same `HOME`/`CODEX_HOME` a turn would use,
  runs `initialize` and the goal request, and ends the process tree. It never
  calls `thread/resume`, because that would start a continuation turn; goal
  requests on an unloaded thread start nothing.
- `CodexEventHandler` — `thread/goal/updated` and `thread/goal/cleared` on the
  parent thread become an `agent_goal_updated` event (`goal: null` for
  cleared). Subagent threads are ignored.
- Rehydrate (req 6) — after `thread/resume` Codex re-announces an existing
  goal but says nothing when there is none, so the handler also runs
  `thread/goal/get` and reports the answer. It asks **after** `turn/start`: a
  request between resume and `turn/start` leaves room for Codex's own
  continuation turn to start first. A new thread reports `goal: null` without
  asking.

### Transport

- `AgentProcess.goalCommand?` (optional; only Codex has it) and
  `AgentCapabilities.supportsGoals?` (absent is false), published to the
  client on `agent_list`.
- Container mode: `ProxyAgentProcess.goalCommand` →
  `ContainerSessionRunner.goalCommandOnWorker` → worker `POST /agent/goal
  {agentId, threadId, command}`. The worker uses the live agent when it is
  the same agent and otherwise builds a fresh adapter from its factory, whose
  `goalCommand` runs the control process. The route is additive; an older
  worker answers 404, which the user sees as a "Couldn't … the goal" notice.
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
  message.
- The answer is a `system_notice` (e.g. "Goal cleared.", "Goal (active): …").
- Every goal the CLI reports — from a command, from a notification during a
  turn (the `create_goal` case, req 1), or from rehydrate — goes through
  `recordAgentGoal`, which stores it in the new `sessions.agent_goal` column
  and broadcasts `session_list` when what the chip shows (objective, status,
  budget) changed. Usage-only updates are not written.

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

Automatic continuation needs the process to outlive the turn, and that
touches the post-turn flow (auto-commit, push, queue drain run on `done`),
between-turn message delivery (`turn/start` instead of `turn/steer`), idle
disposal and crash recovery. docs/153 "Process lifetime" is the analysis of
that work. It is a follow-up, not part of this change.

Req 7 (goal mode on only when ShipIt can show and control it) is met by this
change: Codex goal mode stays on, and it is now both shown and controllable.
A short-term `features.goals=false` override was being prepared in a separate
session; with this change in place it is not needed.

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
