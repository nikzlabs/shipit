---
description: Stop a completed turn from being replayed (and visually duplicated) when the WebSocket reconnects after the turn ended via an error or interrupt.
---

# Duplicate turn on WS reconnect

## Symptom

During a deploy/restart, the browser WebSocket to a session flaps several times
in quick succession. After it settles, the **latest turn appears twice** in the
chat. The duplicate survives a browser reload, so it is not a stale client
render — the server re-emits the turn on every reconnect.

Confirmed in production on session `d7caef4c-…`: a redeploy recreated the
orchestrator (~11:03) and the agent container (11:07:20); the browser WS flapped
5× in ~70s (11:07:19–11:08:29). There were **zero** turn-spawn events for the
session, a single worker process, and idle CPU — the agent executed the turn
exactly once. The duplication came purely from replay, not double execution.

## Root cause

The orchestrator keeps a per-runner **turn-event replay buffer** (TurnAccumulator
`_turnEventBuffer`). Every `runner.emitMessage()` appends to it. On a WS
(re)connect, `attachToRunner` (index.ts) replays the un-persisted tail:

```ts
for (const buffered of runner.getTurnEventBuffer().slice(runner.lastPersistedBufferIndex)) { … send(buffered) }
```

`lastPersistedBufferIndex` only advances at two points in `agent-listeners.ts`:
the `agent_tool_result` boundary (~848) and `agent_result` (~1000). The clean
completion path (`agent_result`) additionally calls `runner.clearTurnEventBuffer()`
(~1034), so after a normal turn the buffer holds only the harmless trailing
`session_status(running=false)` and a reconnect replays nothing meaningful.

The **error path** (`agent.on("error")` in `agent-listeners.ts`) and the
**interrupt path** (`onInterruptedTurn` in `agent-execution.ts`) both *finalize
the partial turn into chat history* but did **not** clear the buffer, and they do
not advance `lastPersistedBufferIndex`. So the buffer stayed dirty with the
turn's `agent_event`s. Every subsequent reconnect — including a browser reload —
replayed those events on top of the already-loaded HTTP history, re-rendering the
turn. Because the buffer lives in the runner (which persists across WS
reconnects), the duplicate reproduced on every reload until the runner was
disposed.

A deploy that kills the agent container mid/just-post-turn is exactly the error
path: the proxy agent's SSE drops → `error` event → history finalized, buffer
left dirty → the flapping browser WS replays the turn.

## Fix

Clear the replay buffer on the two terminal paths that finalize a turn into
history but previously skipped the clear, mirroring `agent_result`:

- `ws-handlers/agent-listeners.ts` — `agent.on("error")`: call
  `runner.clearTurnEventBuffer()` right after `runner.running = false`.
- `ws-handlers/agent-execution.ts` — `onInterruptedTurn()`: call
  `runner.clearTurnEventBuffer()` after `persistInterruptedTurn(...)`.

`clearTurnEventBuffer()` also resets `lastPersistedBufferIndex` to 0, so the
replay slice after the clear contains only the trailing post-turn
`session_status` (idempotent), never the turn's assistant/tool content.

In-progress (non-terminal) replay is unaffected: nothing clears mid-turn, so a
viewer that reconnects while a turn is still streaming still catches up on the
un-persisted tail.

## Already-corrupted sessions

Sessions that already hit this bug have the duplicate **rendered** from the dirty
buffer, which evaporates once the runner is disposed (idle cleanup / restart) —
it is not baked into stored history by this path, since replay is a client-render
concern, not a server re-persist. The error/interrupt finalize writes the turn to
history exactly **once**. No data migration is required; the code fix is
sufficient. (If any session is found with a genuine duplicate row in stored
history from an unrelated path, that would be a separate one-off cleanup — none
was observed here.)

## Key files

- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — error-path clear.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — interrupt-path clear.
- `src/server/orchestrator/turn-accumulator.ts` — the replay buffer +
  `lastPersistedBufferIndex` semantics.
- `src/server/orchestrator/index.ts` — `attachToRunner` reconnect replay; added
  `turnEventBufferSize` to the `/api/_test/runner/:id` diagnostic.
- `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` —
  regression tests: an errored turn and an interrupted turn are each not replayed
  on reconnect and appear exactly once.

## Related

- `docs/098-ws-lifecycle-hardening-followups`
- `docs/144-session-switch-latency`
- CLAUDE.md "WebSocket lifecycle MUST NOT affect server behavior"

## Follow-up: duplicate after orchestrator restart

PR 908 fixed dirty **runner** replay buffers after terminal error/interrupt
paths. A second restart-only path remained: the session worker's SSE ring buffer
survives an orchestrator restart because the worker container can keep running
while the orchestrator process is replaced. If the previous turn completed while
the orchestrator was down, the worker is now idle but its `/events` ring still
contains that completed turn's `agent_event`s.

On the next user turn, `ContainerSessionRunner.createAgent()` installs a fresh
`ProxyAgentProcess`, then `_startAgentViaProxy()` connects worker SSE before
posting `/agent/start` (required for spawned/headless sessions that can emit
immediately). Before this follow-up, that first SSE connection used `since=0`.
The worker replayed the old completed turn into the fresh proxy, so
`wireAgentListeners()` treated those events as part of the new turn and could
persist the previous assistant output again.

Fix: `/agent/status` now includes `latestSseSeq`, and a fresh container runner
fast-forwards its SSE cursor to that sequence before connecting SSE for a new
agent start. This discards stale idle-worker replay while preserving the
load-bearing "connect SSE before `/agent/start`" behavior for newly emitted
events. If the probe fails, the runner keeps the old `since=0` fallback so
spawned/headless turns still prefer possible replay over event loss.

Additional key files:

- `src/server/session/session-worker.ts` — exposes `latestSseSeq` on
  `/agent/status`.
- `src/server/orchestrator/sse-connection-manager.ts` — cursor fast-forward
  helper.
- `src/server/orchestrator/container-session-runner.ts` — fast-forwards stale
  worker events before the first SSE connect for a fresh start.
- `src/server/orchestrator/integration_tests/container-agent-wiring.test.ts` —
  regression test for idle-worker stale replay after orchestrator restart.

## Follow-up: abnormal exit (code 143) erased the prior turn

The interrupt path (`onInterruptedTurn`) finalizes a partial turn into history,
but in `turn-executor.ts`'s `done` handler it was gated on
`runner.wasInterrupted`. A process that exits **without** an `agent_result` and
**without** a user interrupt — a SIGTERM / "exited with code 143" from an
idle-kill, container restart, or crash — skipped that finalize. The streamed
assistant rows were written to chat history as `in_progress=1` at each
tool-result boundary but never flipped to finalized. The **next** user message's
turn calls `ChatHistoryManager.replaceInProgress()`, which deletes every
`in_progress=1` row — so the prior turn vanished from the UI on reload.

Fix: the `done` handler now finalizes the partial whenever the turn ended
without a result and is not waiting on auth (`!receivedResult && !sawAuthRequired`),
covering both the user-interrupt and abnormal-exit cases. `onInterruptedTurn` is
WS-only (dispatch leaves it unset and uses `onNoResultExit`), so dispatched turns
are unaffected. Regression test: "an abnormal exit (code 143) preserves the prior
turn when the next message is sent" in `ws-disconnect-resilience.test.ts`.
