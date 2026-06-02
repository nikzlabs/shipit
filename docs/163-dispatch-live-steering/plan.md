---
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
  drain through the guarded `tryDrain`.
- `src/server/shared/agent-registry.ts` — `getAgentCapabilities(id)` static
  capability lookup.

## Tests

- `session-runner.test.ts` — dispatch steers when live steering + streaming are
  active; enqueues when steering off, when non-streaming, and for review turns.
- `integration_tests/live-steering.test.ts` — end-to-end: a programmatic
  `runner.dispatch` mid-turn is steered (not queued); a queued dispatch message
  is delivered at turn end even when the streaming process exits without an
  `agent_result`.

## Scope note

This fixes only the live-steering/dispatch divergence + the never-delivered
drain. The sibling concern — resuming an idle-reaped container and the false
delivery ack — is handled separately.
