---
issue: https://linear.app/shipit-ai/issue/SHI-250
description: Rebuild a running turn from one atomic server snapshot at attach, instead of stitching an HTTP history read onto a separately-cursored WS replay.
---

# Mid-turn reattach: one snapshot instead of two half-baselines

Three independent bugs produced the same user-visible symptom. They are
distinguished by one question: **after the turn ends, does a full page reload
bring the messages back?**

- **Yes** → the client's in-memory transcript diverged; the DB was fine. That is
  the reattach race below, and also
  [the foreground-reconnect race](#third-bug-window-reactivation-loses-the-transcript-anyway)
  found afterwards.
- **No** → the rows are gone from the DB. That is
  [the mid-turn self-wake reset](#second-bug-a-mid-turn-background-task-notification-deletes-the-turn),
  fixed here too and written up in `docs/235`.

## Symptom

Switch to another session while a turn is running, then switch back: the
messages that turn had already produced are **gone** from the transcript. The
turn keeps streaming into the gap as if the earlier part never happened, and the
missing content does not come back on its own.

Same shape on a WS reconnect (mobile backgrounding, a deploy flapping the
socket) — anything that reattaches a viewer mid-turn.

## Root cause

A reattaching viewer rebuilt the running turn from **two independently-sampled
sources**:

1. `GET /api/sessions/:id/history` — the DB snapshot. Chat history holds the
   running turn as `in_progress` rows, rewritten at each `agent_tool_result`
   boundary by `replaceInProgress` (`chat-card-persistence.ts` →
   `buildTurnMessages`).
2. The WS attach replay — `attachToRunner` in `route-registry.ts` sent
   `runner.getTurnEventBuffer().slice(runner.lastPersistedBufferIndex)`, the
   `agent_event`s emitted since the last persist, which the client queues until
   `historyLoaded` and then applies on top of (1).

`lastPersistedBufferIndex` encodes the claim *"everything before this index is
already in the DB."* That claim is only true relative to a history snapshot
taken **after** the persist that moved the cursor. But (1) and (2) are sampled at
different times — the browser fires the history fetch when the socket opens, so
the response lands before or after the attach depending on latency — and a
tool-result boundary landing between the two samples breaks it both ways:

- **History read first, then a persist, then the attach.** The persist advances
  the cursor past events the client's snapshot doesn't contain. That slice of the
  turn is in *neither* half → it silently disappears.
- **Attach first, then a persist, then the history read.** The client's history
  is now a superset of the replay's baseline, and the replayed events re-apply
  content already in it → the slice renders twice.

Neither is repaired afterwards: the client never re-reads history on its own, so
the viewer sits on a wrong transcript until the next switch or reload. (Related,
and the same buffer: `docs/163-duplicate-turn-on-reconnect` fixed a stale buffer
replaying a *finished* turn.)

## Fix

Delete the stitching. `attachToRunner` sends a **`turn_snapshot`** — the whole
running turn, rebuilt from the runner via the same `buildTurnMessages` the
persistence path uses — in the *same synchronous block* that subscribes the
socket to the runner:

```ts
runner.on("message", runnerMessageListener);   // everything after this is live
…
if (runner.running) send({ type: "turn_snapshot", sessionId, messages: buildTurnMessages(…) });
```

Because both happen without an intervening `await`, the split between "baseline"
and "everything after" is a single instant: no event can fall in a gap between
them, and none can be delivered twice. The `agent_event` replay is dropped from
the attach loop (the snapshot supersedes it); the rest of the buffer — the
non-transcript signals like `compaction_status`, `usage_update`, spawn chips —
still replays as before.

The client applies the snapshot by **replacing** its in-progress rows rather than
appending to them, so a history baseline that is stale in *either* direction
converges:

- `ChatMessage.inProgress` marks rows belonging to a still-running turn (set by
  `loadSessionHistory` from the DB's `in_progress` flag, and by the snapshot).
  Distinct from `streaming`, which marks only the one bubble being written to.
- `turn-snapshot.ts`: `[...prev.filter(m => !m.inProgress), ...snapshot]`.
- `useMessageHandler` queues `turn_snapshot` behind `historyLoaded` alongside
  `agent_event`, so it lands on top of the history baseline and ahead of the live
  events that followed it on the wire, in order.

## Second bug: a mid-turn background-task notification deletes the turn

The reattach race explains a transcript that a reload repairs. The reporter's
did **not** — which means the rows were gone from the DB, not just from client
memory.

`agent_self_wake` (docs/235 §6) resets the runner's turn state so a turn the
orchestrator never started gets a clean accumulator. But it rides on the CLI's
`task_notification`, which fires whenever a `Bash(run_in_background)` job
finishes — **including a job started earlier in the current turn**, which
commonly reports back while that turn is still streaming. The handler reset
unconditionally, so a mid-turn notification cleared `chatMessageGroups` of a
*running* turn. The next tool-result boundary then called `replaceInProgress`,
which deletes every `in_progress` row for the session and re-inserts from the
now-truncated accumulator — erasing the turn's opening from chat history
permanently. The live viewer never noticed (it doesn't re-read history); a reload
or session switch showed the turn missing its first half, for good.

Fix: `if (!runner.running) resetRunnerTurnState(runner)`. A notification arriving
during an orchestrator-owned turn belongs to that turn; only a notification that
arrives while nothing is in flight is a wake. docs/235's intent is preserved —
`integration_tests/self-wake-midturn.test.ts` pins both halves.

This one is the more destructive of the two: no client-side change can recover a
deleted row.

## Why not reconcile at turn end

A snapshot pushed at `agent_result` would look like a natural safety net ("the
lost messages never come back even after the turn ends"), but it is not safe as
written: the client only marks rows it received from history or a snapshot as
`inProgress`. Live-streamed assistant rows, steered user bubbles, and the ~12
card handlers all append without that marking, so a push-based reconciliation
would leave them in place and append a **second copy** of the entire turn.

Making it safe means tracking the running turn's start index client-side and
replacing the tail from there. `WsTurnSnapshot.final` is reserved for it and the
handler already implements the clear-instead-of-set behavior; nothing emits it.
Today a finished turn reconciles at the next attach, which reloads history from
the DB where the turn is complete.

## Third bug: window reactivation loses the transcript anyway

Reported after the two fixes above shipped: reactivating the *browser window*
(not a session switch) still dropped messages and tool calls, and a page reload
still brought them back — so, by the question at the top, another client-side
divergence.

The snapshot is correct; what was wrong is that **two of its preconditions were
not actually guaranteed on a foreground reconnect**.

### 1. One reactivation opened several sockets

`useWebSocket.handleForeground` is wired to `visibilitychange`, `focus`,
`pageshow` and `online`. A single window reactivation fires two or three of
them in separate event-loop turns, and each called `reconnectForForeground()`
unconditionally — even on a socket that was already OPEN. React commits between
those turns, so the socket effect re-ran each time: one reactivation, up to
three teardown/create cycles, three server-side attaches, three
`loadSessionHistory` calls.

Now the burst is coalesced (`FOREGROUND_COALESCE_MS`, 1s): the first event
reconnects, the rest are no-ops. A connect that doesn't take is still covered by
the existing 300/1200/3000ms retries and then normal backoff.

### 2. A superseded history load still wrote its result

`loadSessionHistory` guarded only on `useSessionStore.sessionId` still matching.
Nothing cancels a load when the connection it was issued for is replaced, and
two loads for the *same* session pass that guard, so overlapping loads could
land out of order. When the older one landed last it did two destructive things:

- `setMessages` rewound the transcript to the DB snapshot it had read. For a
  running turn the DB only holds rows up to the last tool-result boundary, so
  everything the turn produced since — text, tool calls, cards — was wiped, and
  live events only append after that, so the hole never healed. **This is the
  reported symptom.**
- `setHistoryLoaded(true)` fired mid-reconnect, breaking the ordering invariant
  the snapshot depends on: `useMessageHandler` queues `turn_snapshot` only while
  history is *not* loaded, so that it lands **on top of** the baseline. With the
  flag spuriously raised, the snapshot was dispatched immediately and applied
  its replace-filter against an arbitrary transcript.

Fix: `historyLoadSeq` — a monotonic id of the most recently *issued* load. A
response may only be applied if no later load has been issued since. Last
request wins, not last response.

### 3. `inProgress` was never cleared on the client

The replace-filter's scope marker is `ChatMessage.inProgress`, and only two
paths set it: a history load of a running turn, and the snapshot itself.
**Nothing cleared it.** The server drops `in_progress` from every row at
`agent_result` (`finalizeInProgress`); the client did not, so rows of a turn the
viewer happened to be attached to kept the marking for the rest of the session's
life. Any later attach sends a snapshot of whatever turn is running *now*, and
`prev.filter((m) => !m.inProgress)` then deleted those finished turns along with
the running one it meant to replace.

Fix: the `agent_result` branch of `handleAgentEvent` clears `inProgress`
alongside `streaming`, mirroring the server. That bounds the replace-filter to
the turn actually in flight — which is what the snapshot's contract always
assumed.

The three compose: (1) creates the overlapping loads, (2) lets a stale one win
and mis-orders the snapshot, (3) turns a mis-ordered snapshot from a harmless
no-op into a deletion.

## Key files

| File | Role |
|---|---|
| `shared/types/ws-server-messages/agent.ts` | `WsTurnSnapshot` + the invariant it encodes |
| `orchestrator/route-registry.ts` | `attachToRunner` — snapshot + the trimmed replay loop |
| `orchestrator/chat-card-persistence.ts` | `buildTurnMessages` — one rebuild shared by persist and snapshot |
| `client/hooks/message-handlers/turn-snapshot.ts` | Replace-not-append application |
| `client/hooks/useMessageHandler.ts` | Queues the snapshot behind the history baseline |
| `client/utils/session-data.ts` | Carries `inProgress` from history onto `ChatMessage`; `historyLoadSeq` — only the newest issued load may write |
| `client/hooks/message-handlers/agent-event.ts` | `agent_result` clears `inProgress`, mirroring `finalizeInProgress` |
| `client/hooks/useWebSocket.ts` | `handleForeground` — coalesces the reactivation burst into one reconnect |
| `client/components/MessageList/types.ts` | `inProgress` vs `streaming` |
| `orchestrator/ws-handlers/agent-listeners.ts` | `agent_self_wake` — reset gated on `!runner.running` |

## Tests

- `integration_tests/turn-reattach-snapshot.test.ts` — the snapshot covers the
  turn when a persist lands between the history read and the attach; no
  `agent_event` echo on top of it; no snapshot when no turn is running.
- `client/hooks/message-handlers/turn-snapshot.test.ts` — replaces a stale
  in-progress tail, corrects a baseline that ran ahead, marks only the last row
  streaming, clears a stale tail on an empty snapshot.
- `integration_tests/ws-disconnect-resilience.test.ts` — the existing
  "unpersisted streaming events reach a reconnecting viewer" contract, retargeted
  from the replay's wire shape to the invariant.
- `integration_tests/self-wake-midturn.test.ts` — a mid-turn `task_notification`
  leaves the running turn's rows in chat history (through turn end); a genuine
  self-wake after the turn finished still gets a clean accumulator instead of
  re-persisting the previous turn.
- `client/utils/session-data.test.ts` — two overlapping loads for the same
  session: the older response neither overwrites the transcript nor flips
  `historyLoaded`.
- `client/hooks/message-handlers/turn-snapshot.test.ts` — a snapshot for the
  running turn leaves a *finished* turn's rows alone once `agent_result` has
  cleared their `inProgress`, and still replaces the running turn's own stale
  rows.
- `client/hooks/useWebSocket.test.ts` — a reactivation burst
  (`visibilitychange` + `focus` + `pageshow`, each in its own event-loop turn)
  opens one socket, not three; a genuinely later reactivation still reconnects.
