---
issue: planning#247
title: Sub-agent result delivery — one artifact, named and re-readable
description: Make the text `shipit agent run` hands the invoking agent provably the same artifact the UI renders, and recoverable when the call dies.
---

# Sub-agent result delivery — one artifact, named and re-readable

## The report

planning#247: for a single `shipit agent run --agent codex`, the text delivered to the
**invoking agent** on stdout and the text shown in the **ShipIt UI** were
different documents, and the agent's copy was materially less complete — a
different opening sentence, two sections missing, ~9 findings where ~15 existed.
Three of the lost findings were design-changing; they were recovered only
because a human noticed the discrepancy and pasted the UI copy back by hand.

The failure was **silent**: nothing in the agent's copy said it was partial.

## What we found

`services/sub-agent.ts` writes `result.text` to **both** surfaces — the consult
card's `outputMarkdown` and the HTTP response the shim prints — from one place,
and the relay legs (`shipit` shim → worker `/agent-ops/agent/spawn` →
orchestrator → worker `/agent/spawn`) forward the body verbatim. Sub-agent
events never reach SSE, so the UI has no second, richer source to render from.
So a *single* run cannot produce two documents today.

That leaves two mechanisms that produce the reported symptom, and both are real:

1. **The captured artifact was a suffix of the answer.** `runAgentToCompletion`
   kept only the *last* completed assistant message (`streamCompletionText ??
   lastFullText`). Codex re-emits each **completed** `agentMessage` item with
   `isStreamCompletion`, and a long turn completes more than one — a full report,
   then a wrap-up ("I found nine definite problems…"), plus any preamble message.
   Last-one-wins silently discarded everything before the tail. The observed
   opening lines are exactly the shape of two messages from one run.
2. **Two runs, indistinguishable.** The reporter's foreground `shipit agent run`
   was SIGTERMed by the invoking agent's 10-minute Bash cap, then re-run in the
   background. Killing the shim does **not** stop the spawn: the orchestrator
   route keeps awaiting it, the run finishes server-side, and it emits its own
   persisted consult card. So the UI legitimately held a card the agent never
   saw, next to a second card from the run it did see. Nothing named either one,
   so "the UI shows something different" was unfalsifiable from either side.

Both fixes below are cheap, and we do not need to decide which mechanism bit —
after this change each is closed and the remaining case is *checkable* rather
than a guess.

## The design

**One artifact, named; and the artifact outlives the call.**

### 1. Capture the whole answer, not its last message

`runAgentToCompletion` now accumulates **every** completed assistant message in
order and joins them with a blank line, falling back to the last full message
for adapters that never emit `isStreamCompletion` (Claude one-shot, whose
`agent_assistant` events are whole messages and whose last one is the answer).
Consecutive identical completions are deduped so a re-emitting adapter can't
double its output.

This is scoped to stream-completion adapters on purpose: for Codex,
`isStreamCompletion` fires once per *completed* `agentMessage` item, so joining
them reconstructs the assistant's actual output — the same sequence the UI shows
for a normal Codex turn. Claude's behavior is unchanged.

### 2. Name the run in both places

`runSubAgent` returns its `spawnId`, which is the same id already on the consult
card. `shipit agent run` prints it on **stderr** (stdout stays the sub-agent's
verbatim text):

```
shipit agent run: run 9f3c… — this is the same text ShipIt renders inline for the
user. Re-read it any time with: shipit agent result 9f3c…
```

Two consults in a turn produce two cards; without an id, neither side can say
which run they mean. This is what turns "the UI has more" from an unfalsifiable
impression into a checkable claim.

### 3. `shipit agent result [RUN-ID] [--json]`

Re-reads the run's **persisted consult card** — literally the artifact the UI
renders, not a re-derivation of it. No id ⇒ the session's most recent run; an
unambiguous id prefix is accepted.

Reading the card (rather than a new run store) is the point: the guarantee
"the agent can fetch exactly what the user sees" holds by construction, and it
costs no new table, column, or migration.

It is also the **recovery path**. A run whose shim was killed still finishes and
persists; before this, its output existed only in the UI and 18 minutes of work
were unrecoverable from the agent's side.

### 4. Don't die silently on SIGTERM

`shipit agent run` installs a termination handler for the in-flight window
(`onTerminationSignal` in `shim-common.ts`; Node's default is to exit with no
output, which is exactly wrong when the work continues server-side). On SIGTERM
it prints where the output will be and that the run is still going, then exits
non-zero.

### 5. Documentation

`src/server/shipit-docs/agent.md` now states the parity guarantee ("if you and
the user seem to be reading different reports, you are looking at two different
*runs*"), tells the agent to **launch long consults in the background** because
a foreground shell cap (10 min in Claude Code) is shorter than the consult cap
(30 min), and documents `shipit agent result`. The foreground ceiling was
previously undiscoverable until it bit.

## Follow-on: backgrounding needed a durable in-flight surface (planning#280)

§5's "launch long consults in the background" landed before the UI had anywhere
to *show* a backgrounded consult. docs/144 §7 built the in-flight spinner as
emit-only transient state on the reasoning that a consult blocks the primary
turn ("no assistant content streams for the duration"), which this doc's guidance
made false: the in-flight state now routinely outlives its turn and every session
switch the user makes.

In the field that produced a 15-minute Codex review that left **no trace at all**
— the switch wiped the spinner, the user read the session as stuck and hit
Restart agent, and the force-dispose killed the spawn without landing any card,
so `shipit agent result` was empty too. Fixed in `docs/144` §7a: the consult card
is created `pending` at spawn time and patched to terminal on completion, in-flight
spawns are cancelled at `dispose` with a terminal card, and the transport is
bounded. That section, not this one, is the reference.

## Deliberate non-changes

- **No UI change** *(superseded by planning#280 — see above; the card is now created
  at spawn time and renders a pending state)*. The card already renders the
  verbatim output; the parity guarantee is server-side. A run-id chip on the card
  would be noise for the common single-consult case.
- **A killed shim does not cancel the spawn.** Cancelling would throw away a
  long, expensive consult to avoid a card the caller didn't see; making the
  result *recoverable* is strictly better. (Marking a card "not delivered to the
  agent" would need disconnect detection across two relay legs and an ack from
  the shim — real work, speculative value. Noted, not built.)

## Follow-up: the persisted card was being deleted (2026-08-03)

§3's recovery guarantee — "the result outlives the call" — did not hold in
practice, for the exact usage §5 tells the agent to prefer. A **backgrounded**
`shipit agent run` outlives the turn that launched it, so its consult card fired
with `runner.running === false`. `emitChatCard`'s only path was the *mid-turn*
one: record on the runner, then rebuild the in-progress row set. Post-turn that
is not merely misplaced but destructive — `finalizeInProgress` had already
cleared the turn's rows, so `persistTurnInProgress` re-inserted the whole
finished turn as a second `in_progress=1` copy with the card inside it, and the
**next turn's first `replaceInProgress` deletes every `in_progress=1` row for the
session**, taking the card with it.

Observed in production: a run printed
`shipit agent result ecb1fc11-…`, and that exact command answered *"No sub-agent
runs in this session yet."* An 18-minute Codex review was unrecoverable — the
precise failure this feature exists to prevent. (Secondary symptom: until the
next turn swept it away, the finished turn's assistant message rendered twice.)

**The fix is in `emitChatCard`, not in `runSubAgent`.** The defect belongs to the
primitive: *any* side-channel card that can land after its turn ended hit it, and
the sub-agent consult is simply the one that did so by design. When no turn is
running, `emitChatCard` now appends the card as an already-final history row —
its correct transcript position (it happened after the turn), the same choice
`emitNoticePostTurn` already made for notices, and no longer deletable.
`runner.running` is a sound discriminator because `agent-listeners` always calls
`finalizeInProgress` *before* clearing `running`, so `running === false`
guarantees there is no in-progress set to join.

### How this sits with planning#280 (docs/144 §7a)

planning#280 landed in parallel and moved consult-card *creation* to spawn time: a
`pending` card is emitted through `emitChatCard` when the run starts, and the
terminal status is applied later through `persistCardTransition` — which already
carried the `running` guard, for the same reason described here ("a post-finalize
`persistTurnInProgress` would revive the finished turn as a duplicate in-progress
row"). Between them the two changes close the hole from both ends, and neither
subsumes the other:

- planning#280 removes the *ordinary* backgrounded consult from the hazard: the launch
  happens mid-turn, so the pending card legitimately rides the in-progress turn,
  and only the terminal patch is post-turn.
- This fix covers the emit that planning#280's guard does not reach: **a launch that is
  itself post-turn** — the shim firing from a background shell started in an
  earlier turn. There the *pending* card is what lands with no turn in flight, and
  without the append path it is deleted by the next turn, after which the terminal
  patch has no row to find and reports `persisted=false`.

The regression tests run both shapes (`launched mid-turn` / `launched post-turn`)
against the same assertions; only the post-turn variant fails without this
change, which is the correct division of labour between the two fixes.

Two call sites are affected beyond the consult card, both for the better:

- **User-filed bug reports** (`POST /api/sessions/:id/bug-report` from the UI)
  fire with no turn running and had the identical defect — the card vanished on
  the user's next message. Now appended.
- **The auth-failure notice** (`agent-auth-handler`) is emitted *after* the
  teardown clears `running`, so it now appends instead of riding the in-progress
  set. It flushes the turn's partial output explicitly first (`persistTurnInProgress`),
  which `emitChatCard` used to do for it as a side effect.

Guard tests assert the *guarantee* (the output is still re-readable a turn
later, and still in the transcript both rehydration paths load) rather than which
persistence path produced it: `services/sub-agent.test.ts` runs them against a
real `ChatHistoryManager`, since the failure lives entirely in the
delete/re-insert semantics of `replaceInProgress` that a stub cannot express.

## Key files

| File | Role |
|---|---|
| `src/server/shared/sub-agent-run.ts` | `runAgentToCompletion` — multi-message capture |
| `src/server/orchestrator/services/sub-agent.ts` | `runSubAgent` returns `spawnId`; `getSubAgentResult` lookup |
| `src/server/orchestrator/chat-card-persistence.ts` | `emitChatCard` — mid-turn record/rebuild vs post-turn append |
| `src/server/orchestrator/chat-history.ts` | `listSubAgentConsultCards` — the persisted-card read |
| `src/server/orchestrator/api-routes-agent.ts` | `GET /api/sessions/:id/agent/result` |
| `src/server/session/agent-ops-routes.ts` | `GET /agent-ops/agent/result` broker leg |
| `src/server/session/agent-shim/shipit-agent.ts` | `agent run` footer + SIGTERM hint; `agent result` |
| `src/server/session/agent-shim/shim-common.ts` | `onTerminationSignal` |
| `src/server/shipit-docs/agent.md` | Agent-facing guidance (parity, background runs, `result`) |

## Related

- `docs/144-cross-agent-review` — the spawn primitive.
- `docs/220-cross-agent-review-surfacing` — the content-carrying consult card
  that made the UI copy exist in the first place.
