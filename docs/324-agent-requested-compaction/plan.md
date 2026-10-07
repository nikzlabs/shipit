---
issue: planning#643
title: Agent-requested context compaction — design
description: `shipit compact` records the request; a post-turn step parks the instructions, runs a silent compaction turn, and queues the continuation right behind it when the agent left a note.
---

# 324 — Agent-requested context compaction: design

Implements [`requirements.md`](./requirements.md). Reuses the compaction turn of
[docs/295](../295-compact-context-on-merge/plan.md) and the post-turn step of
[docs/321](../321-agent-requested-restart/plan.md).

## Shape

```
agent turn ──► shipit compact [INSTRUCTIONS] [--note N] ──► sessions.pending_compaction = {instructions, note}
turn ends ──► commit ──► PR/release flows ──► push armed ──► restart step ──► compaction step ──► idle
compaction step, on the current runner only:
   busy (a turn runs, a flow holds the session, a question waits, background work) ──► leave it pending
   otherwise ──► settle the ending turn
             ──► park INSTRUCTIONS as a pending agent notice                       (req 9)
             ──► dispatch the silent "/compact INSTRUCTIONS" system turn            (req 3, 5)
             ──► with a note: the continuation goes to the queue's head            (req 8)
the compaction's own drain ──► the next turn takes the parked INSTRUCTIONS — the continuation, or the user's
```

The compaction runs after the requesting turn because no path compacts a running
turn on all four harnesses (requirements.md, "Platform constraint").

## Pieces

**1. The command (req 1, 2, 3, 7).** `shipit compact [INSTRUCTIONS...] [--note TEXT]`
in `agent-shim/shipit-compact.ts`. Positional words are the instructions, joined
by spaces; both parts are optional. It relays through the worker
(`POST /agent-ops/compact`) to `POST /api/sessions/:id/compact-after-turn`,
marked `containerAccessible`. The route refuses with 409 when the session's
harness has no `supportsCompaction` (Antigravity today), so nothing is recorded
(req 7). A later call in the same turn replaces the request. The output tells the
agent that the compaction runs after this turn, what happens then, and to say in
its reply that it compacts and why.

**2. The request is persisted.** A nullable `sessions.pending_compaction` column
holds `{instructions?, note?}` as JSON, so an orchestrator restart keeps an
accepted request.

**3. The post-turn step.** `runRequestedCompaction`
(`services/agent-compaction-request.ts`) runs at the end of `runCommitAndPr`,
right after the docs/321 restart step, through the same `RequestedRestartTurn`
handle. That placement inherits everything docs/321 verified: it runs on every
terminal path, after the local commit and the armed push, and before `idle`. A
compaction started there therefore holds `running`, so `idle` — and the
remediation it starts — waits for the compaction rather than racing it.

The step acts only when the runner and the turn are current, and leaves the
request pending — the next turn's end retries — when:

- a turn runs (a queued message drained into it), a merge holds the session, or
  another flow's system hold is on;
- the agent waits for the user's answer (docs/322): the compaction runs after
  the user replies;
- the resident process holds background work, which a system turn would
  destroy (the same gate `dispatchOnRunner` reads).

Otherwise the step settles the ending turn first (`turn.settle`, the
executor's `finishTurn`, as docs/321 does). Two reasons: its outcome is read
from runner state that the compaction resets — a stopped turn would otherwise
settle `no-result` instead of `interrupted` — and a system turn (the
continuation of an earlier compaction, the usual case in an autonomous run)
still owns its hold here, which settling releases. If the release started a
queued entry, the request waits for it.

**4. The compaction turn (req 3, 4, 5).** A dispatch with text
`/compact INSTRUCTIONS` (or `/compact`), `systemTurn`, `automatic` and `silent`
— the docs/295 compaction turn, so it shows no user bubble, says "Compacting
context…" in the status bar, and records the ordinary compaction card.
`dispatched-turn.ts` already recognises the text as a compaction and passes the
instructions to the harness: Claude and Grok honour them, Codex and OpenCode
ignore them. The harness's own automatic compaction and the user's `/compact`
are not touched (req 4). Before the dispatch the step reconciles the runner's
agent with the session and re-checks the capability: a harness switched since
the request must not receive `/compact` as an ordinary prompt.

**5. After the compaction (req 8, 9).** Everything that follows the compaction
is put in place **before** it starts, and nothing waits for it to settle:

- **The instructions** are parked as a notice
  (`prompts/agent-compaction-instructions.md`) in their own column,
  `sessions.pending_compaction_notice`, which `consumePendingAgentNotice`
  delivers together with the ordinary agent notice. Its own column because a
  branch move (`setPendingAgentNotice`) overwrites the agent notice whole. The
  compaction turn never consumes notices (`dispatched-turn.ts` excludes a
  compact request), so the first turn after it does — the continuation, or a
  message the user queued during the compaction. Persisted, so it survives an
  orchestrator restart.
- **With a note**, the continuation (`prompts/agent-compaction-note.md`) goes to
  the queue's head as a system, automatic entry with `compactContext: false`, so
  a merged session does not compact a second time (docs/295). The compaction's
  own drain takes it, ahead of anything the user queued meanwhile. If it never
  reaches the agent, its `onTurnComplete` parks the note for the next turn.

Waiting for settlement instead failed in review: OpenCode's compaction reports a
result and never an exit, so a one-shot turn never settles; and the drain runs
queued work before settlement, so a queued message would have started before
the instructions were parked. The drain, which runs at the result, is what
docs/295 already relies on.

Neither text claims that the compaction succeeded. Settlement status is not
evidence of a compaction — a turn with an error result settles `completed` —
and the user-facing record is the card, or the warn notice when the card is
missing (req 5, 6). Handing the instructions back on every harness, not only
where the harness ignores them, is the user's choice (requirements.md,
2026-10-07).

**6. Stop (req 10).** Stop keeps the compaction and ends the agent's own
continuation. `services/agent-compaction-stop.ts` — a leaf module, so the Stop
paths do not import the step — drops the note of a pending request and removes
a continuation already queued behind a running compaction (it marks its
entries in a `WeakSet`). Three places call or check it, because each covers a
window the others miss:

- `handleInterruptAgent` and `killAgent` call it on Stop: a stopped turn that
  never reaches its terminal sequence, and a Stop during the compaction itself
  — whose turn can still settle `completed` if the CLI reports a result.
- The step drops the note when `stoppedByUser(runner)` says the ending turn was
  stopped: a request that landed after the Stop.

The instructions stay parked, so the user's next turn still gets them (req 9).

`killAgent` used to clear `running` unconditionally after awaiting the worker.
The killed turn can end during that await, and its post-turn step can start the
compaction — or its drain a queued message; the clear would then mark that live
turn idle. It now clears only when neither the turn epoch nor the turn phase
(`currentTurnPhase`, new with every false → true of `running`, so it also sees
a successor still in setup) has moved.

**7. Failure (req 6).** A compaction turn that leaves no card gets the docs/295
warn notice from `noteMissedCompaction` (its text is now neutral, because this
compaction precedes no message), and the continuation still runs. A compaction
that cannot start — a harness that can no longer compact, a runner that cannot
start turns, a dispatch that throws — gets the warn notice from the step, and
the note is parked for the next turn with `agent-compaction-not-started.md`. A
dispatch that fails during setup never reaches the turn's own notice, so the
step posts it.

## Known limits

- **A request with no later trigger.** A request left pending (busy, or a rebase
  step with `postTurn: "none"`) waits for the next turn's end; with no next turn,
  it waits for the user's next message. The same limit as docs/321.
- **A Stop with no terminal event.** The note is dropped at once, but the
  compaction itself waits for the next turn's end: the interrupt fallback
  (`post-interrupt-commit.ts`) commits and does not run this step. The same
  limit as docs/321.
- **An orchestrator restart during the compaction.** The instructions are
  persisted, but the continuation sits in the in-memory queue for the length of
  the compaction, so a restart in that window loses it — the window a message
  queued behind a docs/295 compaction has today.
- **A continuation whose setup throws.** The compaction's drain starts a queued
  entry with `runDispatchedTurn` directly, and a setup throw there settles
  nothing, so the note is not parked. This is true of every queued dispatched
  entry, the user's own included; changing what a drain does on a setup failure
  belongs to the queue, not to this feature.
- **An answer hold between the compaction and its continuation** would move the
  continuation out of the queue and out of Stop's reach. It cannot arise: the
  step does not start while a question waits, and a compaction turn asks none.
- **OpenCode's compaction never reports `done`** (planning#644), so its turn
  never settles and its post-turn hold runs to the deadline. The continuation
  is unaffected: it runs from the drain at the result.

## Rejected alternatives

- **Compact inside the running turn.** Only Claude streaming and Codex have a
  live process to take it, and it would replace the context the turn is using.
- **Start the continuation when the compaction settles.** The first design. See
  piece 5: it never ran on OpenCode, and it handed the instructions back after a
  queued message had already started.
- **A note that is always required.** The user chose an optional note (req 8).
- **Hand the instructions back only on Codex and OpenCode.** The user chose one
  behaviour on every harness (req 9).
- **A setting to turn the command off, or a confirmation card.** Nothing asks for
  either; the compaction card is the record.

## Docs to change

- `src/server/shipit-docs/sessions.md` — the command.
- `src/server/shipit-docs/wiki/chat.md` — the agent can compact its own context.
- `agent-shim/shipit.ts` — `HELP`.

## Key files

| File | Change |
|---|---|
| `src/server/session/agent-shim/shipit-compact.ts`, `shipit.ts` | The command and its help |
| `src/server/session/agent-ops-routes.ts` | Worker relay |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `POST /api/sessions/:id/compact-after-turn` |
| `src/server/shared/database.ts`, `src/server/orchestrator/sessions.ts` | `pending_compaction` and `pending_compaction_notice` columns; the notice is delivered by `consumePendingAgentNotice` |
| `src/server/orchestrator/services/agent-compaction-request.ts` | The request, and the step: checks, settle, parked instructions, compaction turn, queued continuation, failure |
| `src/server/orchestrator/services/agent-compaction-stop.ts` | What Stop ends: the pending note and a queued continuation |
| `src/server/orchestrator/prompts/agent-compaction-*.md` | The instructions notice, the continuation, the not-started notice |
| `src/server/orchestrator/turn-executor.ts` | Call the step after the restart step |
| `src/server/orchestrator/session-runner.ts`, `ws-handlers/types.ts` | The `runRequestedCompaction` seam |
| `src/server/orchestrator/bootstrap-managers.ts`, `runner-registry-factory.ts`, `route-registry.ts`, `ws-handlers/agent-execution.ts` | Build and wire the step |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts`, `services/recovery.ts`, `turn-stop-request.ts` | Stop calls the leaf module; `killAgent` clears `running` only for the killed turn (`currentTurnPhase`) |
| `src/server/orchestrator/compact-before-turn.ts` | Neutral missed-compaction notice |

## Review resolution

ShipIt reviewer run d64d24c0-1d0c-4a11-82b1-20dd1c3b5c2f reviewed the first
implementation. Accepted and fixed: the continuation never started on OpenCode;
the instructions reached the agent after a queued message had started; a Stop
during the compaction still continued when the stopped turn reported a result;
`killAgent` could mark the compaction idle; settlement status was read as proof
of a compaction; a stopped non-system turn settled with the wrong outcome; the
Stop paths imported the whole step. All but the last came from one choice —
hanging what follows the compaction on its settlement — and piece 5 replaces
it. Kept as known limits, as in docs/321: a Stop with no terminal event, and an
orchestrator restart during the compaction (now losing only the queued
continuation, not the instructions).

Reviewer run 8fcdec49-e096-4fcd-a25f-3bc151740bb3 checked the redesign and
confirmed those fixes. Accepted and fixed: a branch notice overwrote the parked
instructions (now their own column); the `killAgent` guard missed a successor
still in setup (now also the turn phase); a detached settlement waiter (now the
dispatch's `onTurnComplete`). Recorded as known limits above: a continuation
whose setup throws, an answer hold that cannot arise, and OpenCode's missing
`done`, filed as planning#644 because it affects every OpenCode compaction.
