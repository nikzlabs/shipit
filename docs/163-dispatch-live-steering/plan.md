---
issue: https://linear.app/shipit-ai/issue/SHI-147
description: Make the programmatic dispatch path honor live steering (and reliably drain) so a mid-turn `shipit session message` is injected, not silently queued.
---

# Live steering on the dispatch path (docs/163)

## Symptom

In a session with live steering (docs/140) enabled, a message sent **during an
active turn** through the agent-driven path — `shipit session message` →
worker child-message → orchestrator `sendChildMessage` → `runner.dispatch` —
showed as **"queued"** in the UI and the agent never reacted to it. If the
running turn then ended abnormally (a failed-PR / hook-retry exit), the queued
message was **never delivered at all**.

## Root cause

There are two divergent "send a message to a session" entry points and only one
of them honored live steering:

1. **WS path** — `handleSendMessage` (`ws-handlers/send-message.ts`). When the
   runner is mid-turn and `steeringCapable && liveSteering && streamingActive &&
   !reviewFilePath && !systemTurnInProgress`, it injects the message into the
   running turn via `AgentProcess.sendUserMessage()` and broadcasts
   `message_steered`. Otherwise it queues.

2. **Dispatch path** — `runner.dispatch(...)` in `SessionRunner` /
   `ContainerSessionRunner`. Used by every programmatic caller (child messages,
   quick sessions, CI auto-fix, and the WS path's own "not steering"
   fall-through). It had **no steering branch** — when `_isRunning` it
   unconditionally enqueued and emitted `message_queued`.

So the steer-or-queue decision lived only in the WS handler; programmatic
messages always queued mid-turn even when steering was on.

A second, related defect caused the "never delivered" tail: in the shared turn
executor (`turn-executor.ts`), the streaming post-turn queue drain hung off
`agent_result` only. The streaming `done` handler returned early **without
draining**. A streaming process that exits *without* an `agent_result` (crash,
failed-PR / hook-retry abort) therefore stranded any queued message forever.

## Fix

Smallest change that removes both the divergence and the message loss:

- **One shared decision.** `dispatch-steering.ts` exports `shouldSteerMessage(…)`
  — the single predicate both paths consult. `handleSendMessage` now calls it
  instead of its inline boolean, and the dispatch path calls it via
  `trySteerDispatch(...)`. They can't drift again.
- **Dispatch steers.** `trySteerDispatch` runs inside both `dispatch()`
  implementations before the enqueue branch: when the predicate passes and a
  resident streaming agent exists, it injects the message via
  `sendUserMessage`, records + persists the steered row at its true transcript
  position (`recordSteeredMessage` + `persistTurnInProgress`), and broadcasts
  `message_steered`. Dispatch callers are text-only, so it steers the raw text;
  attachment-carrying sends only originate on the WS path (which does its own
  richer steer before ever reaching `dispatch`).
- **Steering inputs for the runner.** `SystemTurnDeps.steerInputs?()` resolves
  the live `liveSteering` setting + the pinned agent's static
  `supportsSteering` capability. Wired in `runner-registry-factory.ts` from
  `credentialStore.getLiveSteering()` and the new
  `getAgentCapabilities(agentId)` static lookup in `shared/agent-registry.ts`
  (the runner has no live registry handle). Absent ⇒ legacy enqueue.
- **Reliable drain.** The streaming `done` handler now drains the queue through
  the same guarded `tryDrain` the `agent_result` path uses. `agent_result` was
  switched from `input.drainNext()` to `tryDrain()`, and the error-path drain
  (`onError`) routes through `tryDrain()` too — so the queue drains exactly
  once whether the turn ends via `agent_result`, abnormal `done`, or `error`,
  and never twice.

## The dispatched FIRST turn must itself stream

The bullets above make a *resident streaming agent* the prerequisite for
steering a dispatched message. But the originating bug is "an agent spawns a
session and then messages it" — and a child / quick session's **first** turn is
itself started through the dispatch path (`spawnChildSession → runner.dispatch`),
not the WS path. That first turn used to always spawn **non-streaming** ("system
turns spawn a fresh agent"), so `runner.isStreamingActive` stayed `false`. A
follow-up `shipit session message` arriving mid-turn then failed the
`shouldSteerMessage` gate and was **queued** — never injected. The shared
predicate was correct; there was simply never a resident streaming process for
it to steer into.

The fix lives in `dispatched-turn.ts`:

- **Compute the same streaming gate the WS path uses.** `useStreaming =
  !systemTurn && steer.liveSteering && steer.steeringCapable` (via the same
  `steerInputs()` the steer decision reads). A non-system dispatched turn now
  runs as a streaming process exactly as a user-typed WS turn does, so the
  resident agent it leaves behind is steerable. System turns (rebase
  resolution, CI-fix) are explicitly never steered, so they stay non-streaming
  and keep their fresh-agent-per-turn / one-shot post-turn semantics.
- **Reuse the resident streaming process across dispatched turns.** When a
  dispatched turn streams AND a live resident process from a previous turn
  exists (`attempt === 0 && runner.isStreamingActive`), it carries the message
  in via `reuseExistingAgent` (→ `sendUserMessage`) instead of a fresh
  `/agent/start`, mirroring the WS path. Spawning fresh while the worker still
  holds the old streaming process would 409 `/agent/start` and trigger a
  kill+restart (the SIGTERM-143 respawn noise docs/140 fixed for WS). The reused
  process gets `removeAllListeners()` before the executor wires its own, so
  per-turn listeners don't accumulate. A no-result retry always spawns fresh
  (the `done` handler cleared the resident ref on exit).
- **No-result exit fires for streaming dispatched turns too.** In
  `turn-executor.ts` the `onNoResultExit` hook was moved **above** the
  `useStreaming` branch so it runs for both streaming and non-streaming
  dispatched turns. A streaming first turn can still exit with no
  `agent_result` (crash / hook-abort); without firing the hook the streaming
  branch would silently report a *completed* turn, re-masking the
  "first turn never ran" bug. WS leaves `onNoResultExit` unset and is
  unaffected.

## Suppressors preserved

Review turns (`reviewFilePath`), system turns (`systemTurnInProgress`), and the
`isStreamingActive` gate suppress steering on **both** paths identically — a
dispatched message during those states queues and drains at turn end.

## Key files

- `src/server/orchestrator/dispatch-steering.ts` — `shouldSteerMessage` (shared
  predicate) + `trySteerDispatch` (dispatch-side steer).
- `src/server/orchestrator/ws-handlers/send-message.ts` — WS handler now uses
  `shouldSteerMessage`.
- `src/server/orchestrator/session-runner.ts` /
  `container-session-runner.ts` — `dispatch()` consults `trySteerDispatch`;
  `SystemTurnDeps.steerInputs` added.
- `src/server/orchestrator/runner-registry-factory.ts` — wires `steerInputs`.
- `src/server/orchestrator/turn-executor.ts` — streaming `done` + `onError`
  drain through the guarded `tryDrain`; `onNoResultExit` hook fires for both
  streaming and non-streaming dispatched turns.
- `src/server/orchestrator/dispatched-turn.ts` — computes `useStreaming` for
  non-system dispatched turns and reuses the resident streaming process across
  turns (`reuseExistingAgent`), so a spawned session's first turn is steerable.
- `src/server/shared/agent-registry.ts` — `getAgentCapabilities(id)` static
  capability lookup.

## Tests

- `session-runner.test.ts` — dispatch steers when live steering + streaming are
  active; enqueues when steering off, when non-streaming, and for review turns.
- `integration_tests/live-steering.test.ts` — end-to-end: a programmatic
  `runner.dispatch` mid-turn is steered (not queued); a queued dispatch message
  is delivered at turn end even when the streaming process exits without an
  `agent_result`; **a dispatched FIRST turn (spawned child / quick session)
  starts as a streaming process so a follow-up dispatch steers instead of
  queuing** (the "spawn a session, then message it" bug).

## Scope note

This fixes only the live-steering/dispatch divergence + the never-delivered
drain. The sibling concern — resuming an idle-reaped container and the false
delivery ack — is handled separately.
