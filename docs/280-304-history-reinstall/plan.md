# Plan — a validated 304 on `/history`: install and seed conditions

Implements `docs/280-304-history-reinstall/requirements.md`. Tracks
planning#467. The issue asked two questions to be established before any fix;
both were, and both answers contradict the issue's implied fix direction. The
code, not the issue, wins (per the brief and per CLAUDE.md's
"verify an inherited guarantee at the source").

## Findings

### Q1: Can the cached payload truncate the live transcript? — No permanent truncation; ordering is guaranteed by construction.

The install (`setMessages` with persisted rows only) does transiently rewind a
live running turn to its last persist boundary. It heals in the same tick
chain, by construction rather than by luck:

1. **Server, every attach**: `/ws/sessions/:id` opens run `activateSession`
   (`route-registry.ts:1458`) → `attachToRunner` (`route-registry.ts:1280`,
   def. `:1036`), which — when `runner.running` — sends a fresh
   `turn_snapshot` built synchronously from the runner's in-memory groups,
   minus the already-committed prefix (`route-registry.ts:1070-1094`). Every
   reconnect is a new attach, so every reconnect during a running turn gets a
   current rebuild.
2. **Client, queueing**: on every disconnect the socket passes through
   `closed`/`connecting` (`useWebSocket.ts:103,118`), and `useConnectionSync`
   lowers `historyLoaded` there (`useConnectionSync.ts:190-222`);
   `resumeSessionInternal` also lowers it on a switch that starts while the
   socket never left `connecting` (`session-actions.ts:105`). While the flag is
   false, `useMessageHandler` queues `turn_snapshot`, `agent_event`, and
   `sub_agent_spawn` (`useMessageHandler.ts:73-79`) and drains them only when
   it flips true (`useMessageHandler.ts:43-50`).
3. **Client, install-before-flag**: `loadSessionHistory` runs `setMessages`
   (`session-data.ts:336`) and `setHistoryLoaded(true)` (`session-data.ts:425`)
   with no `await` between them — no interleaving is possible.
4. **Client, heal**: `handleTurnSnapshot` replaces *all* `inProgress` rows
   with the attach-time rebuild (`turn-snapshot.ts:51`); history-installed rows
   of the running turn carry `inProgress` from the payload
   (`session-data.ts:336-341`). Persisted prefix + live tail = complete
   transcript.

When the turn is *not* running at reconnect there is nothing to heal: every
terminal path persists (CLAUDE.md invariant 2), so any post-cache row write
bumped the transcript revision and the response would have been `200`.

A `304` also cannot carry a stale field anywhere else in the payload: the
server composes its validator from the transcript revision **and** the entire
non-transcript rest — commits, `agentRunning`, background tasks, rewind
snapshot, usage series and totals, presentations — plus a wire-shape version
(`api-routes-session-spawn.ts:182-223`). A matching tag asserts every payload
source is unchanged, so "install the cached object" and "parse the fresh body"
are semantically identical operations.

**Conclusion:** not a defect. The issue's conditional — "if it is incidental,
this is a live transcript-truncation window" — resolves to *it is not
incidental*.

### Q2: What is the card re-seed protecting against? — The attach-time buffer replay landing emit-time phases ahead of the baseline; protection needs only the card fields.

1. `SessionRunner.emitMessage` buffers **every** outgoing message into the
   turn-event buffer (`session-runner.ts:2035-2049`) — including the four card
   types.
2. On attach, the server replays buffered messages from
   `lastPersistedBufferIndex`, skipping `agent_event` / `turn_snapshot` /
   log / terminal / `background_tasks` but **not** the card types
   (`route-registry.ts:1112-1139`).
3. Card messages are *not* queued behind `historyLoaded`
   (`useMessageHandler.ts:73-78` names exactly three types), so a replayed
   `bug_report_card` reaches `upsertCard` immediately — creating a `draft` /
   `pending` entry if absent (all four stores' `upsertCard` are
   non-clobbering).
4. The history seed (`seedCards`, an authoritative overwrite) then corrects
   the phase to the persisted terminal state. Skipping it on a `304` leaves a
   filed report as an editable draft and a resolved permission re-offering
   Approve/Deny — the closed PR #2536's failure mode, which the issue's
   constraint forbids.

The seed needs only the four card fields extracted from `data.messages`; it
never needed the transcript body. And because a replayed card may equally land
*after* the load completes, the reverse order is covered too: `upsertCard`
never overwrites an existing entry, so a seeded terminal phase survives a late
draft replay. Both orders converge; the seed must simply always run.

**Conclusion:** current behaviour (seeds on every completed load, `200` and
`304` alike) is correct and required.

### Why the tempting fix is wrong

Skipping `setMessages` on a `304` ("nothing changed ⇒ installing is a no-op")
breaks session switch-back: `resumeSessionInternal` cleared `messages` and
lowered `historyLoaded` (`session-actions.ts:85,105`), so the install is the
baseline restore for the incoming session — "nothing changed on the server"
does not mean "nothing changed in this tab". The install must run on every
completed load, unconditionally.

## Change

No behavioural change — none follows from the findings. Instead:

- `src/client/utils/session-data.ts`: the four inline seed blocks become one
  named step, `seedCardStoresFromHistory(messages)`, called unconditionally on
  every completed load, with a docstring carrying the Q2 finding (what the seed
  protects against, why it must never be gated on transcript-change). The
  `304` branch gets a comment carrying the Q1 finding (why the install always
  runs). This makes the invariant structural: the next reader cannot gate the
  seeds without arguing with a docstring that cites why not.
- `src/client/utils/session-data.test.ts`: guard tests pinning (a) a `304`
  re-seeds filed/resolved phases over a replay-created draft, (b) a `304`
  installs the cached transcript into a cleared store, (c) `historyLoaded`
  flips true only after the messages are installed, (d) all four card kinds
  seed on the first (`200`) load too — the seed is unconditional, not a
  `304`-only patch. (a) and (b) fail against the two regression shapes
  planning#467 warns about; (c) fails against any reorder of install/flag.
  They pass against this branch by design, because the verified behaviour was
  already correct — see requirements.md Resolved question 3.

Verified live against the dogfood inner instance: an archived fixture session
carrying all four persisted card kinds; first `/history` load `200` with
`ETag "Eb_jSDk459tkOL-OzsC8vJjPI0E"`; an SPA switch-away-and-back sent
`If-None-Match` and received `304`; after the `304` the transcript rendered
whole and the bug-report card rendered its persisted `filed` phase (#4242),
not a draft.

Out of scope, noted for follow-up: card stores are never *cleared* by a load
whose payload no longer contains a previously-seeded card (a rewind removing
rows leaves a ghost store entry). Pre-existing, identical on `200`, untouched
here.
