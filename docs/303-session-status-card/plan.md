---
issue: planning#550
title: Session status card — design
description: Behind a setting, one agent tool carrying status, needs-you and persistent offered actions; one session-record column; one element at the end of the conversation, just above the composer; a ShipIt-started follow-up turn when a turn ends without an update.
---

# Session status card — design

Implements [requirements.md](requirements.md), cited as `(req N)`. Remaining
work: [checklist.md](checklist.md). The review history is on planning#550;
choices the human did not make are listed under "Agent decisions" at the end.

## Setting (req 21–23)

One declaration in the settings catalogue
(`src/server/shared/settings-catalogue/global-settings.ts`, the
`defineSetting` shape of `advanced.enableSubAgents`):
`advanced.sessionStatusCard`, tab `advanced`, scope `global`,
`bool({ default: false })`, label "Session status card", description: an
agent-written card just above the composer with the session's status, what
needs you and the offered follow-up actions; while on, the agent offers
actions through that card instead of the follow-up-actions card.

The flag gates one point per surface. Off is today, byte for byte.

| Surface | On | Off |
|---|---|---|
| Agent tools | `session_status`; no `propose_actions` | `propose_actions`; no `session_status` |
| Prompt | the "Session status" section | the "Proposing optional follow-up actions" section |
| Turn settlement | freshness mark and nudge run | both return at once |
| Client | `SessionStatusCard` rendered | not rendered; transcript action cards as today |

**Reaching the agent.** The flag rides the per-turn run params and becomes
`SHIPIT_SESSION_STATUS_CARD=1` in the agent's spawn environment, as
`SHIPIT_AUTO_CREATE_PR` does (`src/server/session/agents/claude/process.ts:243`).
The tool list is chosen from it in three places, all of which must see it:
`writeMcpConfig`'s context (`src/server/shared/types/agent-types.ts:428`,
forwarded by `src/server/session/mcp-config-controller.ts:23`), each of the
five adapters' `SHIPIT_MCP_TOOLS` strings, and Claude's own tool allowlists
(`process.ts:148`, `:436`). The tool itself is registered in the bridge's
registry (`src/server/session/mcp-shipit-bridge.ts:17`); an id absent there
is filtered silently at line 41.

**Resident agents.** A spawn variable does not reach a process that outlives
its turn: the reuse path sends the next message to the resident process and
builds no run params (`turn-executor.ts:1026`; Claude's own shortcut at
`agents/claude/adapter.ts:382`). Two mechanisms bring residents in line, and
the first is the main one: the setting can only change through a running
orchestrator, so the **save hook itself** (`onSessionStatusCardToggled`, fired
in both directions) retires every idle resident at the toggle — including one
adopted after a restart, which has no recorded value to compare. A session that
is mid-turn is left alone, because killing its process would lose the turn; it
is caught by the **second** mechanism when its next interactive turn starts:
`buildAgentRunParams` records the value each spawn carries
(`session-status-spawn-record.ts`, the one place the value is decided, so every
spawning path writes it), and `releaseResidentOnStatusCardChange`
(`ws-handlers/agent-execution.ts`) retires a resident whose record disagrees
with the setting. A *dispatched* turn makes its own reuse decision
(`dispatched-turn.ts`) and calls the same helper on the same comparison, reading
the setting through `SystemTurnDeps.statusCardEnabled`, so a session that was
mid-turn at the toggle is brought in line whichever kind of turn comes next. A
toggle therefore applies from the next turn on every harness.

**Re-enable (req 23).** A save hook for the key (`services/settings.ts`,
`SAVE_HOOKS`, the `advanced.autoFixCi` pattern) runs on false → true: every
stored card is marked stale and `session_list` is broadcast, so the earlier
card reappears at once, marked, and the next turn refreshes it. Off hides the
card and changes nothing stored.

**Prompt.** Two variants of the system prompt, both rendered once at module
load and picked per turn by the flag — the prompt-cache contract of the
`prompt-architecture` skill, unchanged.

## Shape

| Piece | Precedent |
|---|---|
| Agent tool `session_status` | `propose_actions` (`src/server/session/mcp-tools/propose-actions.ts`), which it stands in for while the flag is on |
| Session-record column, broadcast with `session_list` | `agent_goal` (docs/154, `services/agent-goal.ts`) |
| Last element of the scrolling conversation | the trailing rewind point at the end of the `contentRef` element in `src/client/components/MessageList/MessageList.tsx` |
| ShipIt-started follow-up turn | the dispatch path `wakeSessionWithTurn` uses (`wake-session.ts`, `dispatched-turn.ts`) |

Nothing enters the transcript except the nudge turn itself, so none of the
persisted-card machinery (`emitChatCard`, `CARD_MESSAGE_FIELDS`, history
rehydration) is involved.

## The tool (req 4, 5, 16–18)

`session_status`, id and name both `session_status`, in
`src/server/session/mcp-tools/session-status.ts`. Arguments, validated in
`src/server/shared/session-status-validation.ts`:

| Field | Limit | Meaning |
|---|---|---|
| `lastTurn` | optional, plain prose, ≤ 400 chars; **not a delta** — an accepted call that omits it CLEARS the stored line (req 31) | One or two sentences on what the agent did in the turn that is ending, or the direct answer when the user asked something. |
| `status` | optional, markdown, ≤ 1200 chars; omitted: unchanged; required while no card is stored | What the session is about, how far it got, whether it is done or ready to merge, and agent work not yet started. The whole session, not the last turn. Markdown, so it may carry a short list (req 27). |
| `needsYou` | optional repeated field: a list of strings, each ≤ 240 chars, at most 10; omitted: unchanged; `[]`: cleared (req 27) | One entry per decision or hand action only the user can take. Empty when nothing. |
| `actions` | optional list; each item `id`, `label`, `description`, `defaultChecked?`, `payload` (≤ 4000 chars) — the `propose_actions` item shape, validated by `validateActionItems`, extracted from `propose-actions-validation.ts` and shared. `description` is REQUIRED here (req 26) and stays optional for `propose_actions`, so the rule is `requireOfferDescriptions` (`shared/session-status-offers.ts`), applied by the tool and by the route on the validated items rather than by the shared item validator, which serves both tools | Agent work the user approves with a click. |
| `replaceActions` | optional boolean, default false | `false`: add the given items to the offered list. `true`: the given list becomes the offered list; an empty list clears it. |

An empty `actions` is valid only with `replaceActions: true`. There is no
count limit on offers (req 18); the length limits are the concision (req 2).

**Confirming (req 14).** A call with no arguments changes nothing and marks
the card current: it is the agent saying the card still holds. Every field
is a delta on the stored card — omitted means unchanged — so a partial call
("only `needsYou` changed") is the same mechanism. A bare call on a session
with no stored card is refused with a message asking for `status`. Every
accepted call, bare or not, sets the turn's `statusUpdated` and bumps
`writeSeq`.

**`lastTurn` is the one field that is not a delta (req 31).** It names the turn
that is ending, so carrying it into the next write would make it describe a turn
that is over — the misleading state req 31 rules out. Every accepted call
therefore rewrites it or clears it, the bare confirming call included: a
confirmation says the *session* still holds, and it is not a claim about a turn.
The rule lives in `recordSessionStatus`, which reads `write.lastTurn` instead of
falling back to the stored one, and the prompt and the tool description both
state it, because an agent that expects delta semantics everywhere would
otherwise drop its own line by accident. The section is also hidden while the
card is stale — a presentation rule in the card, not a write: a stale card's
status is still roughly true of the session, while its turn line is by then one
turn behind, which req 31 says is worse than none.

**Offer identity and reconciliation (req 17).** Every stored offer carries a
server-assigned `offerId`. On any write, an incoming item that equals a
stored one — same `id`, `label` and `payload` — keeps that offer's `offerId`,
`offeredAt`, provenance and `takenAt`; an item whose `id` matches but whose
label or payload changed replaces it with a new `offerId`, untaken; a new
`id` is a new offer. So a replacement that repeats a taken offer unchanged
keeps it taken, a changed offer arrives as a fresh unselected item, and a
submit composed before a change removes or marks nothing (the checkbox, the
submit and the mark all use `offerId`). The agent's `id` is a name, not the
identity; `propose_actions` ids are unique only within one card
(`propose-actions-validation.ts:53`).

**Call path.** Tool → worker `POST /agent-ops/session-status` (a `relay` line
in `agent-ops-routes.ts`) → orchestrator
`POST /api/sessions/:sessionId/session-status` (`containerAccessible: true`,
`api-routes-session-status.ts`). The route validates, captures `branch` and
`headSha` for the offers it creates (as `api-routes-propose-actions.ts` does),
persists, broadcasts, sets the turn's `statusUpdated`, and answers with one
line saying the card is on screen, followed by the offered list with each
item's taken state, so the agent can keep or replace offers knowingly. It reads
`runner.turnEpoch` before the provenance and persist awaits and sets
`statusUpdated` only if it still matches: a stop and a successor turn can land
inside those awaits, and the credit for a write belongs to the turn that made
it. The route refuses while the setting is off, as `propose-actions` refuses
while it is on, so neither card can be written from the other side of a toggle.

## Storage (req 10)

- `sessions.session_status` column, JSON
  `{ lastTurn?, status, needsYou?: string[], actions: OfferedAction[], fresh, writeSeq }`;
  `OfferedAction` is the item plus `offerId`, `offeredAt`, `branch?`,
  `headSha?`, `takenAt?`. Migration via `addSessionColumnIfMissing`
  (`database.ts`).
- `writeSeq` increments only on an accepted agent `session_status` call, a
  bare confirmation included. Freshness marks and
  taken marks change the record but not `writeSeq`; it is the guard the
  settlement step uses to tell "a later turn wrote" from its own mutations.
- `SessionInfo.sessionStatus?: SessionStatus` (`domain-types/session.ts`),
  read in `sessions.ts` `fromRow`, written by `SessionManager.setSessionStatus`.
- `services/session-status.ts`: `recordSessionStatus` (any accepted agent
  call: merges the given fields into the stored card, bumps `writeSeq`,
  sets `fresh: true`), `markSessionStatusStale(sessionId,
  ifWriteSeq)` (no-op when `writeSeq` moved), `takeOfferedActions(sessionId,
  offerIds)` (stamps `takenAt`; an unknown `offerId` marks nothing). Each runs
  inside `runStatusExclusive`, the `runGoalExclusive` chain copied from
  `agent-goal.ts:31`, and broadcasts `session_list` when something shown
  changed.

Because the value rides `SessionInfo`, every viewer, a reload, a switch and
an orchestrator restart show the same card with no extra request.

**Lifecycle.**

- New session: no card until the first write (req 22).
- Conversation reset and rewind: keep status and offers, mark stale. After a
  rewind the card may describe work that is gone; "Stale" says so. The mark
  lives inside `SessionManager.clearAgentSessionId`, beside the goal's clear,
  because that one method is what every reset and rewind reaches — nine call
  sites, of which a shared helper would only be remembered by some. It returns
  whether the card changed, and `clearConversationThread`
  (`services/session-status.ts`) pairs that with the `session_list` broadcast,
  so a viewer cannot keep a card that reads current. The two recovery paths that
  discard a thread — `recoverMissingConversation` and the credential-repair
  `onRecover` — go through it too; `SessionAgentEnvDeps` gained an optional
  `sseBroadcast` for the second.
- Fork (`forkSession`, `session-fork-merge.ts`): copy the parent's card,
  marked stale. It is the fork's starting point.
- Archive: the row keeps the column; restore brings the card back.
- Toggle: see "Setting".
- Dismissal: the composer is the control (CLAUDE.md §5). "Drop the retry
  idea" is a message; the prompt tells the agent to answer with
  `replaceActions`, and to drop taken offers the same way once done.

## Turn settlement (req 11–15)

**One flag on `TurnAccumulator`**, `statusUpdated`, set by the route on
every accepted call — a bare confirmation included — and reset with the
accumulator at turn start (`session-runner.ts:452`, reached by
interactive, dispatched and adopted turns: `turn-executor.ts:169`,
`dispatched-turn.ts:307`, `agent-listeners.ts:145`). A question needs no
flag: Claude's native `AskUserQuestion` and the MCP `ask` tool both reach the
interrupt at `agent-listeners.ts:616` (the worker synthesizes the tool_use in
`session-worker.ts` `registerAskEndpoint`), which sets `runner.wasInterrupted`;
plan approval sets the same flag.

**The facts are taken at settlement, after any adoption handover and before the
drain.** `settleTurnFacts` runs at the head of the terminal sequence, before the
post-turn hold and outside `postTurnStep`, so it may not throw: its status read
is guarded and skipped entirely while the setting is off, or a failed read would
abandon the commit behind it (invariant 3). It runs *after* `await
rearmInFlight`, because a turn adopted there owns the path it landed on and the
predecessor's snapshot would be discarded by the re-arm. And it reads a separate
`sawOwnResult`, not `receivedResult`, which adoption deliberately keeps from the
predecessor: a crashed adopted turn produced no result of its own to judge.

`wasInterrupted`
and the accumulator are runner state that the drained successor resets
(`session-runner.ts:448`), and the successor starts before the network
post-turn work and `idle`. So a helper `settleTurnFacts()` runs first thing
on each of the four terminal paths CLAUDE.md invariant 2 names — the clean
`agent_result`, the abnormal `done`, the adapter `error`, the failed auth
heal (`turn-executor.ts:223`, `:524`) — before their `drain` step, and
adoption resets it where it resets the other memoized work
(`turn-executor.ts:756`). It does two things at once:

1. Copies `{ statusUpdated, wasInterrupted, receivedResult, harnessCommand,
   statusNudge, postTurn, writeSeq }` into an executor-local snapshot.
2. If the turn is not a `harnessCommand` (req 36) and `statusUpdated` is false, calls
   `markSessionStatusStale(sessionId, snapshot.writeSeq)` — immediately, so
   the card never reads as current between a missing update and the end of
   the network flow. The guard makes it a no-op if a later turn already
   wrote.

**The nudge decision** is a memoized step after `idle`, on the snapshot
alone. It says **no** when: `statusUpdated`; `wasInterrupted` (question,
plan approval, user stop); no `agent_result` (a crash has its own recovery);
`harnessCommand` (req 36, below); the turn was itself a nudge; `postTurn: "none"` (a
driver-owned turn); the record's `writeSeq` moved past the snapshot's; or a
successor is pending (a deferral, not an exemption — the check repeats when
that turn ends). Otherwise it dispatches the nudge.

### What is checked, and why (req 36)

The rule is one question asked of the turn: **could this turn have changed what
the card says?** A turn the harness runs as its own command on the conversation
answers no — the agent does no work of the session's, so the card is not behind
and there is nothing to ask about. Every other turn answers yes, whoever started
it.

`harnessCommand` on `TurnInput` and `TurnStatusFacts` is that property: the turn
is a compaction. Each turn path decides it where it already knows —
`opts.compact` on the interactive path (`ws-handlers/agent-execution.ts`),
`isCompactRequest` on the dispatched one (`dispatched-turn.ts`).

The dispatched path narrows it further, and **deliberately errs towards
checking**: it withholds the exemption when provenance wraps the text (a
cross-session or agent-interface message). The harnesses disagree there — Claude
reads the wrapped prose and does ordinary work, while Codex and OpenCode compact
from the `compact` flag and never see the prompt at all
(`codex-event-handler.ts`, `opencode/adapter.ts`). Exempting would hide a
genuinely stale card on Claude; checking costs one needless nudge on the other
two. The first is the failure req 15 forbids, so the condition takes the second.

The exemption also requires the arriving result to be **this prompt's**
(`ownTurn !== "queued"`). A user's `/compact` can reuse a resident CLI, and that
CLI can start a turn of its own during environment preparation, before the
command is submitted; the result that then arrives ends the CLI's work, not the
compaction, and that work is exactly what the card must report.

It **replaces** the `silent` entry rather than joining it. `silent` named a kind
of turn — ShipIt's own, with no user row — and named it wrongly: ShipIt's
pre-turn compaction is silent and was exempt, while the *user's* own `/compact`
is an ordinary interactive turn and was nudged, which is planning#594. The
property covers both, and covers a compaction sent through the HTTP message API
as well, because none of them is a path the rule reads.

**The property belongs to the turn being settled, not to the executor.** A
compaction leaves the CLI resident, and an executor serving a turn the CLI then
starts of its own (`rearmForCliStartedTurn`) would otherwise re-read the
compaction's `input` and exempt real work — the card reading current when it is
not, which is exactly what req 15 forbids. So the executor holds
`harnessCommandTurn`, cleared in the re-arm beside `sawOwnResult`, and does not
read `input` at settlement: `servingAdoptedTurn` is already false by the time the
adopted turn's `agent_result` settles.

**Considered and rejected: a `/goal` command.** It is delivered verbatim for the
same reason a compaction is, and `ridesTurnGoalCommand` looked like the other
half of one predicate. It is not: the harness answers `/goal` by *starting work*
(Grok's `set` and `resume` re-enter its planner and verifier,
`agents/grok/grok-goal.ts`), so exempting it would suppress a stale mark the
session had earned. "Delivered verbatim" and "produced no work" are two
properties, and only the second is the rule's. The prefix guards therefore keep
reading the verbatim predicate, and the settlement reads this one.

**Known limit.** A compaction that spans an orchestrator **restart** is adopted
with no prompt text and no harness-command identity in the worker's status
(`turn-adoption.ts`), so it settles as an ordinary turn: marked stale, nudged
once. This is unchanged from `silent`, which was never carried across adoption
either; closing it means carrying the property through the worker's run body and
status the way `statusNudge` is.

`harnessCommand` also governs the **stale mark**, which `silent` governed before
it: a turn that produced no work of the agent's own cannot have left the card
behind. The driver-owned exemption keeps its existing split and is deliberately
not folded in — a conflict-remediation turn (`postTurn: "none"`) does real work,
so the card IS marked stale after it; it is only the *nudge* that is withheld,
because a git driver owns the interval around it.

Every ShipIt-started turn, enumerated from the dispatch sites rather than from
memory, walked against the rule:

| Turn ShipIt starts | Where | Checked? |
|---|---|---|
| Merged-PR wake | `merge-watch.ts` → `wake-session.ts` | **yes** — it leads to the next piece of work |
| Delivered result of a brokered agent run | `services/consult-result-delivery.ts` → `wake-session.ts` | **yes** |
| A child session's report to its parent | `services/session-report.ts` → `wake-session.ts` | **yes** |
| Continuation after a quota refusal | `services/quota-continuation.ts` → `wake-session.ts` | **yes** — the turn it resumes is the session's work |
| CI fix | `services/github-ci-fix.ts`, `app-lifecycle.ts` | **yes** |
| Continuation after a rebase | `services/rebase-followup.ts` | **yes** |
| Credential remediation after a blocked push | `services/secret-block.ts` | **yes** |
| A child session's first prompt; a message sent to a child | `services/child-sessions.ts` | **yes** |
| A headless session's prompt | `services/headless-sessions.ts` | **yes** |
| A message through the HTTP API | `services/agent.ts` | **yes**, unless its text is itself a harness command |
| Conflict remediation | `services/rebase-driver.ts` (`postTurn: "none"`) | **no nudge**, driver-owned; still marked stale |
| Pre-turn compaction before a post-merge turn | `dispatched-turn.ts`, `runCompactionAhead` | **no** — `harnessCommand` |
| A compaction wrapped as another session's message | `services/child-sessions.ts` | **yes**, conservatively — see the narrowing above |
| The status nudge itself | `turn-executor.ts` | **no** — req 15, one attempt per missing update |

**A pending successor is four things, not two** (req 34, planning#589), and the
last two are read from the turn's own snapshot rather than live. A turn
`running` and a message queued are the obvious two, and they are properties of
the session *now* — they say a successor has already taken it. The other two say
this turn left a message unanswered, which nothing live can see:

- **`steered`** — a message went into the turn while it ran. A steer goes
  straight to the CLI, so it is neither running nor queued. This is the shape
  the report named: steering an agent that was waiting on background work
  produced a nudge instead of the message, and not merely a needless question,
  because the nudge is a system turn that retires the resident process holding
  it. `recordSteeredMessage` is also how an agent-interface message and a
  cross-session message arrive, and the nudge would destroy those too, so req 34
  covers them by name.
- **`promptQueued`** — this turn's *own* prompt went in behind a turn the CLI
  had already started, so the `agent_result` that arrives ends the CLI's turn
  and not ours (`ownTurn`, docs/299-agent-settings-access req 8). Every live
  signal reads idle and the prompt is still unread. The prompt lifecycle
  deliberately never moves a queued prompt on — which result answered it is
  undecidable — so the deferral is spent **once** per executor
  (`queuedPromptDeferralSpent`); reading the state itself would defer every
  later turn this resident settles.

**Both are taken in `settleTurnFacts`, with the rest.** Read live at the
decision they describe whichever turn owns the runner by then, not the one being
judged: a successor's `resetRunnerTurnState` clears the steered set, and so does
this executor's own re-arm. That is the same reason `wasInterrupted` and the
accumulator are snapshotted there. The dispatch re-check therefore re-reads only
the live pair; re-reading the snapshot's reasons there would reintroduce exactly
that confusion.

**Why the whole turn, rather than only an unanswered message.** The narrower
rule is the one to want and the orchestrator cannot express it. The only
positional information it holds is `SteeredMessage.afterGroupIndex` — the
transcript-group count when the message was **sent** — and comparing that with
the count at settlement is wrong in both directions: the turn's own closing text
can land before the CLI acknowledges the steer, which makes a pending steer look
answered, and an answer appends to the *existing* group unless a boundary
happens to be armed (`accumulateAssistantGroups`), which makes an answered steer
look pending. Note this also means `requeueUndeliveredSteers` does **not**
guarantee that every un-acked steer has become a queued message by settlement —
it re-queues only those with no output after them — which is a further reason
not to treat the remaining entries as "acked, therefore taken". The cost of the
whole-turn rule is one skipped nudge on a turn a message reached and the agent
then answered without touching the card; the card is still marked stale, which
is req 14's answer, and req 34 records the trade.

The deferral cannot outlive its turn: `resetRunnerTurnState` clears the steered
set at the start of every ordinary turn and of every adopted CLI-started turn
(`agent-listeners.ts`), and the queued-prompt deferral is one-shot.

**Dispatch.** Not during the post-turn hold: a completed system turn keeps
`systemTurnInProgress` until `finishTurn` (`turn-executor.ts`), and a
dispatch made before that queues behind it after the final drain has run
(`session-runner.ts`). Deciding and dispatching are therefore two steps: the
step after `idle` records the decision and tries the dispatch, and `finishTurn`
tries it again once it has cleared the hold. Both are needed — a system turn's
hold is still on at the first, and an ordinary streaming turn whose CLI stays
resident never reaches the second, because `finishTurn` runs only when the
process exits. The dispatch re-checks there that the runner is free, on the same
three-part successor test — a successor that appeared meanwhile defers the nudge
rather than queueing behind it, and that turn is checked afresh when it ends —
and then goes through
`runner.dispatch`, not an enqueue plus a drain entry: only that path owns
recovery when turn setup rejects, and without it a user message that queued
during setup is left with nothing to start it. Two gates are pre-checked
instead of queueing behind them, since one attempt is all a missing update gets
(req 15): a runner with no dispatch dependencies, and a resident agent with
background work a system turn would destroy. The nudge is a dispatched system turn, not
`silent`: its prompt is echoed as the turn's user row (`system_user_message`),
the reply follows, the post-turn flow runs as for any turn (req 12). The
prompt opens with `[ShipIt]`, says the last turn ended without a status
update, lists the current offers with their taken state, and asks for one
`session_status` call and nothing else — a bare one if nothing changed. Its
prose is `prompts/status-card-nudge.md`, loaded once at module load, with only
the offer list composed in TypeScript.

**And the nudge is a successor like any other.** It starts inside the
predecessor's post-turn sequence and, being a system turn, replaces the resident
process — so that process's own late `done` must not clear `runner.running`,
which by then belongs to the nudge. The streaming `done` branch now carries the
`turnIsCurrent()` guard `tryDrain` beside it always had; without it the live
turn read as idle and its runner was reclaimable (invariant 5). Any successor
drained during a streaming turn's post-turn had the same exposure.

**Identity.** `statusNudge: true` is a typed dispatch option on
`AgentDispatchOptions`, added to `AgentDispatchInit` and
`queuedMessageToDispatchOptions` (`prepared-dispatch.ts`, whose type-level
asserts catch an omission), **and** to `QueuedMessage` and the hand-written
`toQueuedMessage` (`session-runner.ts`), which compaction uses
(`dispatched-turn.ts`) and which `queue-drain.test.ts`'s `Required<>`
round-trip is what actually guards. It reaches `TurnInput`, as does `silent`,
which was not forwarded before.

**The flag.** The settlement reads it through `SystemTurnDeps.statusCardEnabled`
(`credentialStore.getSessionStatusCard()`, wired in `runner-registry-factory.ts`
and `ws-handlers/agent-execution.ts`). With the setting off, neither the
freshness mark nor the decision runs, so a session that never had a card is
never asked for one. It is read at each use rather than captured at turn start:
the setting takes the tool with it, and a nudge decided while it was on must not
start a turn asking for something the agent can no longer call.

**Bound (req 15).** The step says no for a turn whose snapshot has
`statusNudge`. An ignored nudge leaves the card stale; the next ordinary turn
is checked afresh.

**And it survives an orchestrator restart.** `adoptInFlightTurn` rebuilds an
adopted turn from what the worker reports, so the marker travels with the turn
rather than with the orchestrator: the spawn carries `statusNudge` in the
`/agent/start` body (set on the process by `executeAgentTurn`, as `deliveryId`
is), the worker holds it for the turn's life beside `turnDeliveryId` and reports
it on `/agent/status`, and `InFlightTurnInfo` hands it back to the adopted turn.
A nudge that spanned a restart therefore settles as the nudge it is and is not
nudged a second time (req 15).

**Its own lease spans the dispatch, not just the call.** `dispatch` sets
`running` synchronously, but the turn epoch — what tells a predecessor its exit
no longer owns the runner — only advances when the successor enters its
executor, and setup (`preTurnReset`, attachment resolution) awaits in between. So
the nudge holds `beginPostTurnWork` until its `TurnHandle` settles. `PostTurnHold`
expires on its own, so a turn outliving the deadline is covered by `running` and
the epoch by then.

## Client (req 6–9, 14, 17, 18, 20, 24, 26–30)

`SessionStatusCard` (`src/client/components/SessionStatusCard.tsx`), rendered
as a direct child of the `contentRef` element in
`src/client/components/MessageList/MessageList.tsx` — last while the agent is
idle, after the trailing rewind point; at the frozen turn anchor while a turn
runs (req 30, below). It is inside the scroll container, so it scrolls away with
the conversation (req 6); the question card, a transcript row, sits above
it (req 8); and `useMessageScroll`'s observer on that element already keeps
the view pinned to the bottom when the card appears or grows. It is not a
transcript row: it reads `currentSession.sessionStatus` from the session
store and renders nothing without one. `text-xs`, semantic tokens only. It is
**three capped cards in a stack** (req 33), not one card with rules in it:

```
┌─ ⏱ Status ──────────────────────────────────────── Stale ─┐  ← soft cap: accent on tint
│ Billing service. Markdown, so a list reads as a list:     │  ← lighter tinted body
│   - routes and tests done; PR #212 ready to merge         │
│   - webhook not started                                   │
└───────────────────────────────────────────────────────────┘
┌─ 🕘 Last turn ────────────────────────────────────────────┐  ← neutral: no accent
│ Wired the webhook route and its signature check; green.   │     at all, the ordinary
└───────────────────────────────────────────────────────────┘     card surface
┏━ 🪜 Next steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  ← filled cap, last
┃ ✋ Manual steps                                            ┃
┃ ☐ Add the Stripe test key in Settings → Secrets.          ┃  ("I've done this")
┃ ────────────────────────────────────────────────────────  ┃
┃ ☑ Follow-ups                                              ┃
┃ ☑ Wire the Stripe webhook               RECOMMENDED       ┃
┃   Adds /webhooks/stripe and its signature check.          ┃
┃ ☐ Add a README section on billing       SENT              ┃  (greyed, tickable again)
┃   What the service does and how to run it locally.        ┃
┃ [ Submit ]  Add comment…                                  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

`mockup.html` is the drawing of the look as it ships, in four themes, fresh and
stale. The rounds that led to it are kept beside it, because the look is still
being iterated on and a round is worth more than a summary of it:

| File | Round |
|---|---|
| `mockup.html` | The shipped look: three capped, accent-tinted cards. |
| `look.html` | Round 1 — surfaces only: solid, an accent spine, an elevated panel, a recessed tray, against the translucent baseline. Rejected: still reads as another transcript card. |
| `look-loud.html` | Round 2 — louder: accent tint, an accent header cap, a full-bleed band, a bigger card, all three at once. Drawn in the card's real neighbourhood (agent prose above, composer below), which is what the first cut of this round got wrong. **Tinted** chosen. |
| `look-tinted.html` | Round 3 — the three capped cards, with the three sub-questions still open: how much colour, one middle card or two, where "Stale" goes. All three ruled; `mockup.html` is the chosen combination. |
| `mockup-freshness.html` | The original prototype, from before the card had sections: how freshness is shown (the "Stale" label in the accent colour). Its card shape is superseded. |
| `look-step-comment.html` | A comment per manual step (req 37): five options, including doing nothing and the existing "Add comment…", plus what the agent receives and a 390px comparison of the two that differ only in cost. **C** chosen. |

The rows, the
badge and the submit button are the existing follow-up action card's, so a
checkable item reads the same wherever the user meets one, and every offer
shows its description (req 26).

- **Three cards, and why (req 33).** The card shipped as one translucent
  surface and read as "one more transcript card" — the complaint that opened
  this round was that it blends into the conversation text. Each card is now a
  cap (icon + 13px semibold label) over a tinted body, bordered in the accent.
  Nothing else in a conversation is coloured in the accent, so the stack is the
  one coloured object on the screen — which is *findability*, not attention:
  req 9 is about the sidebar indicator and is untouched. `Gauge` caps the
  status, `ClockCounterClockwise` the last turn, `Steps` the next steps.
- **Three tones, and the order (req 33).** `TONES` in the component holds them.
  **loud** — `bg-(--color-accent)` cap with `text-(--color-accent-text)`, body
  `bg-(--color-accent-subtle)`, full accent border — is for the card that
  *asks*: Next steps, which carries the single Submit and therefore goes
  **last**, nearest the composer. **soft** — `bg-(--color-accent-subtle)` cap
  with `text-(--color-accent)` and a `/30` divider, body `bg-(--color-accent)/5`,
  border `/45` — is for the one that is *read*: Status, first. **neutral** —
  `bg-(--color-bg-tertiary)` cap with `text-(--color-text-secondary)`, body
  `bg-(--color-bg-secondary)`, `--color-border-secondary` border — is the
  ordinary card surface, for the aside: Last turn. Loudness tracks what a card
  wants from the user, so the eye lands on the only one with a control in it,
  and the accent comes to mean "the session, and what to do about it".

  **`--color-info` is not available for the neutral card**, though it is the
  better name for it: it is the *same value* as `--color-accent` in
  `light.css`, `cool-light.css` and `antigravity.css`, so it would
  differentiate nothing in three of the 20 themes. `--color-pr` is the only
  coloured token distinct from the accent everywhere, and it means "pull
  request" throughout the rest of ShipIt. Hence the ordinary surface.
- **The Next steps card (reqs 28, 29).** One card named **"Next steps"** holds both
  lists under the one Submit they share: **"Manual steps"** (`ClipboardText`,
  `needsYou` keeps its field name) and **"Follow-ups"** (`ListChecks`), as
  subtitles inside it with a rule between them, each omitted when empty and the
  whole card omitted when both are. A subtitle is an accent icon beside a 13px
  semibold primary label. A manual step is a checklist row whose toggle means
  "I've done this" (req 29): the same rows as the offers, with that hint as the
  row's title and in each checkbox's accessible name.
- **A note per manual step (req 37).** Each step row carries a quiet
  `ChatCircleDots` control at its right-hand end; pressing it opens a two-row
  textarea under the step, inside the row's own tint. A step is submitted when it
  is ticked, when it carries a note, or both — not done · done · answered — so
  the Submit is enabled by a note alone, and an unticked row with a note carries
  an **ANSWERED** pill (`ChecklistItem.tag`, the RECOMMENDED styling) because an
  unticked row otherwise means "nothing will be sent".

  **The shape has one owner, and the note does not change it.** `needsYou` stays
  a list of strings with no server-side identity. Nothing stores a note: it rides
  one message and is gone, exactly as the locally-known "SENT" grey is. So the
  row's identity stays its text — which is what makes a note and a grey survive
  an agent rewriting the list around it — and the only addition is a suffix for a
  repeated entry (`stepKeys`), so two identical steps are two rows rather than
  one duplicated React key. Giving a step an `offerId`-like identity would mean a
  column, a migration and a reconciliation pass for a value that never reaches
  the server.

  **Where the control lives is load-bearing.** A `<button>` inside the row's
  `<label>` activates the checkbox as well as itself, so pressing "Add a note"
  would report the step done. `ActionChecklist` therefore grew
  `renderTrailing` / `renderBelow`, both rendered **outside** the label and
  inside a new row wrapper that now carries the tint — so the note sits inside
  its row rather than beside it. jsdom does not forward a label activation, so
  the guard is on the DOM (`control.closest("label")` is null); a click test
  passes with the button nested and proves nothing.

  **The control is a toggle, and nothing else closes the field** — in particular
  not a blur. An earlier cut closed an empty field when focus left it, so that a
  stray press cost no height, and that is a real defect: the close runs on
  **mousedown**, lifting everything under the field before mouseup lands, so the
  click that caused it is swallowed. Pressing Submit with an empty note open
  submitted nothing. It was found in a browser and not by the test beside it,
  which dispatches `blur` and `click` as separate events and cannot see the
  interaction; the guard is therefore that the field survives a blur, which goes
  red the moment the handler comes back. Pressing the control again closes the
  field **and drops the note**, which is what the control's label says it does:
  a field kept open out of sight would submit words the user cannot see.

  A successful submit clears every note and closes every field — the note is in
  the transcript by then, and the card does not keep a second copy — and greys
  the answered rows as reported ones. A **refused** submit keeps the notes with
  the ticks, so Submit retries the whole of what the user composed.

  **A note of whitespace is not an answer**, on the row or in the message: the
  ANSWERED mark reads the trimmed note, as the submission does, or a row would
  claim to be sending something that is then dropped. And an already-sent row
  that carries a NEW note is marked ANSWERED **beside** its SENT: the mark is
  the caller's to set, so `ActionChecklist` renders `tag` on a taken row too,
  because SENT alone would deny a pending re-answer.
- **The unticked checkbox carries its own surface.** `ActionChecklist` draws an
  empty box as `bg-(--color-bg-primary)` inside `border-(--color-border-secondary)`.
  The old borderline-only box all but vanished on the tinted body — worst in
  dark themes, where `--color-border-primary` is a hair off the tint. The change
  is in the shared component, so the transcript action card gets it too.
- **Freshness.** A current card carries no mark. A stale one carries the word
  **"Stale"** (`text-[11px] font-semibold text-(--color-accent)`, the soft cap's
  own colour, never faded) at the right-hand end of the **Status cap** — the
  stack has no single bottom-right corner any more, and the first cap is read
  first (req 14). No tooltip: its
  wording would be wrong after a toggle or a rewind, and the label is real text
  for assistive technology.
- **Actions.** The presentational checklist of `ActionChecklistCard` — items,
  selection, the Send button — is extracted into a shared piece; the
  existing transcript-row wrapper keeps its formatting, repeat-submission,
  delivery-failure and "Add comment…" behavior unchanged, and the status
  card gets a wrapper of its own — same rows, same badge, same button (req
  26). On the status card: selection is keyed by
  `offerId`; `defaultChecked` applies when an offer first appears; a taken
  offer renders in `--color-text-tertiary`, unticked, with a "SENT" tag where
  an untaken one carries "RECOMMENDED", and leaves only when the agent removes
  it (req 17). It stays TICKABLE: an agent can crash or ignore the message, and
  re-sending is a second tick rather than a control of its own — `taken` is
  presentation, not a lock. Untaken
  offers stay selectable while the card is stale (req 24); an offer whose
  message has been sent reads as taken at once, without waiting for the
  server's `takenAt`. The card keeps the transcript card's submit button,
  its "Add comment…" shortcut and its delivery-failure notice (req 26); it has
  no single-button variant, because an offer list that changes shape with its
  count would flip between two layouts and cannot show a taken offer. Submit composes a message of the same
  shape as the transcript card's, with each offer's own `offeredAt` and
  `headSha` (offers outlive status writes, so provenance is per offer, not
  per card), and carries the ticked `offerIds` as `sessionStatusOfferIds` on
  `send_message`. The steps the user reports doing ride the SAME message, under
  their own heading (req 29), so one Submit covers the whole card; a reported
  step needs no offer, so `sessionStatusOfferIds` is omitted when none was
  ticked. **Steps take two headings, not one** (req 37): "I have done these
  manual steps:" and "I answered these manual steps without doing them:", with
  each step's note on its own indented `Note:` line under it. Two headings
  rather than a per-line qualifier because the distinction is what the agent
  acts on — a refusal read as a report of finished work is exactly the failure
  the split exists to prevent — and the note under its own step is what keeps it
  attributed when several are submitted at once. The `[Action card → Submit]`
  marker leads whichever block comes first, and appears exactly once.
  **Both boundaries are enforced, not assumed**: a note is a textarea, so every
  line of it is indented rather than only the first, and a step's own text is
  folded onto one line — otherwise a later line reading `- …`, or a line that
  repeats a heading, arrives as a step of its own. "Add comment…" composes with
  the same rule, since the user edits that text in the composer and a note that
  breaks out of its step there is the same defect.
  The button is labelled "Submit", never a count.
- Not on the sidebar row (req 7); not an input to `computeAttentionReason`
  (req 9). The field is on `SessionInfo`, so the sidebar could read it; it
  must not.

### Out of the way while a turn runs (req 30)

The card's place in the conversation is an **anchor**: the number of messages
that were settled when the current turn started. While a turn runs the card is
rendered after the rows for those messages, so everything the turn produces
renders below it and it leaves the viewport the ordinary way. When the turn
stops the anchor clears and the card is the last element again.

**Freezing the anchor.** A ref in `MessageList`, `{ sessionId, anchor }`.
While `isLoading` is false the anchor is null. On the first render with
`isLoading` true, a non-empty transcript and no anchor, it is set to the
message count **less the trailing run of user rows and streaming rows**. It is
read from `messagesProp`, not the `useDeferredValue` copy the rows are built
from: `isLoading` is not deferred, and pairing the two mixes generations — a
successor turn starting before the predecessor's last reply has caught up would
see that reply still marked `streaming` and freeze one row short of it, for the
whole turn. A
user row belongs to the turn that is starting rather than to the finished
conversation, so trimming it makes the anchor independent of whether the store
appends that row before or after it sets `isLoading`. A streaming row is
trimmed for a different reason: it goes on growing **in place** rather than
appending, so counting it settled would leave the turn's own text above the
card. The ref is cleared when the session changes.

**Empty is not an anchor.** Switching to a session whose turn is already
running clears the messages and sets `isLoading` before the history arrives, so
the first loading render can see an empty transcript; freezing there would
anchor the card above the whole conversation once the history landed. The
anchor waits for a non-empty transcript. A viewer who **joins mid-turn** then
freezes on what it has: the card sits after it and the rest of the turn renders
below — the same experience, one turn late.

**From messages to rows.** `elementLastMessageIndex` turns the message anchor
into a row count: the first visual element whose **last** message reaches the
anchor. The last, not the first, because a tool-group merges consecutive
groupable tools across messages and only a user row breaks the run — so a turn
with no user row of its own (a dispatched one) can leave its first tools in the
same group as the settled turn's last ones. Keying on the group's first message
would put that group, the turn's tools included, above the card. A rewind that
truncates the transcript past the anchor leaves the count at the end of the
rows, which is the idle position.

**Where it goes in the DOM.** `MessageList` builds one keyed array — the row
groups, the sub-agent chips, the trailing rewind point and the card — and hands
it to `CompactLayout`, which renders its children as a fragment, so all of them
stay direct children of `contentRef` as they are today. The card is one keyed
element of that array in both states, so moving it is a **reorder**, not a
remount: its ticked offers, its locally-known "SENT" rows and its reported
manual steps survive the move. Two JSX sites would remount it, and the moment
that matters is the one right after Submit — the submission starts a turn, and
a remount there would drop the grey from the rows the user had just sent.

**The group boundary.** Rows are chunked into `content-visibility` groups of
`ROWS_PER_GROUP` (planning#491). A partial last group would keep absorbing the
turn's new rows, which would then render *above* the card, so the anchor
**flushes a group**, splitting one chunk in two. Chunking is unaffected either
side of the split — the row counter runs on, so the next boundary is still the
next multiple of `ROWS_PER_GROUP` — and the split's second half is keyed after
the **same chunk** it belongs to, with a suffix. So removing the split
re-parents only that half's rows — under `ROWS_PER_GROUP` anchored rows, plus a
task panel if one sits in that half — and every other group keeps its identity. A key naming the group's ordinal among
groups would re-key the whole tail each time the anchor moves; a key naming its
first row would survive that but not a mid-transcript removal, which shifts
every row index under it — a case `transcript-row-groups.test.ts` already
holds to ≤2 remounts. Only the live boundary is kept — one extra group at a
time — because a boundary per turn would grow the number of
`content-visibility` elements without bound, which is the cost planning#491
measured.

**Not yanking the view (req 30).** Moving the card back to the end removes it
from above a reader who has scrolled up, which would shift their content by the
card's height. `CompactLayout` already restores a reading anchor across a
row-structure change with `getSnapshotBeforeUpdate`, and it now takes the
card's anchor as a second input to that snapshot. Two details are load-bearing,
and both were found by watching a real turn in the dogfood instance rather than
by reading the code:

- **The card's move has its own guard**, `canPreserveAcrossCardMove`, which
  measures the container instead of reading `autoScrollRef`. That flag is
  deliberately sticky — an appended user row arms it and pins — and a
  *dispatched* turn's user row (a status-card nudge) goes through the same
  path, so it can read true while the view sits a thousand pixels above the
  bottom. And because the move changes no height, no `ResizeObserver` fires to
  correct it: the reader's row simply drops by the card's height. Near the
  bottom nothing is needed at all, since `scrollHeight` is unchanged.
- **The anchor row is re-found by id, not held as a node.** The boundary flush
  re-parents the rows just under the card, so React remounts them — and the row
  the snapshot measured is one of those. Holding the element gives a
  disconnected node and the restore returns silently, which is exactly the
  failure the restore exists to prevent.

A live text **selection** does not stand the restore down, unlike every
auto-scroll path: those would move content the user is holding still, while
this one cancels a displacement they did not ask for, and a selection below the
card is precisely what the card's departure drags out from under the cursor. A
live scroll **gesture** does stand it down — writing `scrollTop` into a fling
fights it, and a reader mid-fling is not holding a row.

**The cases, each decided:**

| Case | What happens |
|---|---|
| Turn ends | Anchor clears; the card moves below the turn's last row. A reader at the bottom needs nothing — the move leaves `scrollHeight` alone, so the bottom stays the bottom; a reader scrolled up keeps their row through the snapshot restore. |
| Switching into a running session | The anchor waits for the history, then freezes at the end of it. |
| A second turn starts straight after | `isLoading` drops and rises, so the anchor re-freezes at the new end: the card sits below the first turn's output and above the second's. If the runner never goes idle between them, the anchor stays where it was and the card stays above both — the same promise, one anchor. |
| A queued message | It is appended after the anchor was frozen, so it renders below the card with the rest of the live output. |
| A turn that produces no output | The anchor equals the end of the rows, so the card is already in its idle place and nothing moves. |
| A turn that ends without a status update | Position is unchanged by freshness: the card returns to the end and carries the "Stale" label (req 14). |
| A tool group straddling the boundary | Placed below the card whole, so a settled tool can end up under it. See the trade-off below. |
| The setting is off, or no card is stored | No card element enters the array and no group is flushed — the transcript is byte-for-byte today's. |

**One trade-off, stated.** A tool-group is a single row spanning several
messages, and only a user row breaks the run — so a turn with no user row of
its own can leave its first tools grouped with the settled turn's last ones.
That one row cannot be on both sides of the anchor, and req 30 asks for two
things of it: the card keeps the place it had, and the turn's output renders
below it. The second is the requirement's purpose — it is the defect Nik
reported — so the whole group goes below the card, and a settled tool can end
up under it in that case. Splitting the visual group at the turn boundary would
honour both, at the cost of changing `buildVisualElements`, which is shared,
performance-critical and covered by contracts of its own (planning#491,
docs/299); it is not worth that for a row shape only a dispatched turn
produces.

### The card is on screen while the transcript is not (req 6, planning#595)

The card renders from the **session record**, not from the transcript, so it
survives the gap a session switch opens: the messages are cleared and the new
ones have not arrived, and the card is the whole of the scrolling content. That
is by design — it is the one thing worth reading while a long history loads —
but it changes what the open path measures, and it broke that path.

Landing at the end of the conversation is the responsibility of
`useMessageScroll`, whose `autoScrollRef` says whether to follow the bottom. The
hook is never remounted across a switch, so that flag — and the two gesture refs
beside it — described the reader of the session being **left**. A reader who had
scrolled back left it false, and both correcting paths read it: the layout
effect bails and the `ResizeObserver` declines, so nothing pins the incoming
transcript.

It survived review and shipping because a clamp repaired it by accident.
Clearing the transcript shrinks the content under the scroll position, the
browser clamps `scrollTop`, and the resulting `scroll` event re-reads
`isNearBottom` as true. That repair needs a position to clamp **from** — and the
card is exactly what removes it, because the loading view can now be scrolled as
far as the card is tall. Measured in the dogfood instance, a 1336px card in a
625px viewport: every outgoing position from 0 to 711 opened the next session at
the top of a 43,000px transcript. With the setting off the same path failed only
at exactly 0, which is why the card correlates with the report without being its
cause.

So the follow-the-bottom and gesture refs are reset when the **displayed**
session changes, keyed on the deferred session id — the same generation the rows
are built from — and on identity rather than on observing the switch, so a
viewer that misses an intermediate render still resets (docs/095).

**The reset is in the pinning layout effect, not in the render.** These refs
drive listeners that are live on the transcript still on screen, and a deferred
render can be abandoned: a reset written from a render that never commits leaves
the OUTGOING session following its bottom, and the observer then drags a reader
who did not ask for it. A layout effect runs only on a commit. `sessionId` joins
its dependencies so an identity change pins even when the message array does
not.

**A selection outlives the switch, and is cleared with them.** Every pinning
path stands down for a text selection inside the container — and the card keeps
its DOM, so a selection made in the card is still inside the container after the
transcript has gone, holding the incoming conversation off its end. A click
collapses a selection, so this is reachable only when the session is opened
without one: the back button, a keyboard switch, a link. Verified in the dogfood
instance with the back button, where the selection survived the switch intact.
The selection belongs to a conversation that is no longer on screen, so the
session change collapses it rather than obeying it.

Guard: `src/client/components/MessageList/session-open-scroll.test.tsx`, which
mounts the real list and walks the whole open sequence, loading gap included.
The follow flag, the two gesture refs and the selection clearing were each
removed on their own and watched fail; the message-count reset and the effect's
`sessionId` dependency are consistency rather than separately guarded
behaviour, and the fixture says so.

#### Landing there is not the same as pinning there (planning#595, second report)

The reset above makes the first pin HAPPEN. It does not make it LAND, and the
report came back: *"I switch to a session, first see the card immediately, and
then the conversation loads, sometimes scrolling to the top."*

The open is a single pin followed by a chain of **conditional** corrections, and
the pin itself is wrong when it is made. Measured in the dogfood instance, two
900-message sessions with a 1,094px card, instrumented per frame:

| Moment | Position / height |
|---|---|
| Loading gap, card alone | 501 / 1,126 |
| Layout effect's pin, rows just committed | 79,714 / 80,339 |
| After the groups paint | 83,450 / 84,075 |

The pin measures a `content-visibility` **estimate** — every group reports its
`contain-intrinsic-size` until Chrome renders it — so the effect finishes about
4,300px above the end, and the corrections arrive 600–760ms later. Everything
that closes that gap can stand down inside it: the settle loop ends after three
stable frames or a 1s cap (in several traces `settle-end` is logged *before* the
correction), the `ResizeObserver` declines for `autoScrollRef`, for a live
gesture and for a text selection, and a single `scroll` read taken while the
content is taller than the pin sets `autoScrollRef` false **and** cancels the
loop. Any one of those firing in that window leaves the reader at the position
the loading gap left — which, with the whole conversation now rendered beneath
it, is its top.

So `useMessageScroll` holds an **open**: `openUntilRef`, armed on mount and at
each displayed-session change, and given a deadline of `OPENING_HOLD_MS` (1.5s,
over the measured 760ms) at the commit that first puts a conversation on screen.
It changes exactly two things. `handleScroll` does not record a position the hook
itself wrote — `pinnedTopRef` — so reading our own pin back against a height that
has since grown no longer latches auto-follow off and cancels the loop. And the
`ResizeObserver`, which is the correction that closes the estimate, answers to
the open rather than to a follow flag describing a conversation that was not on
screen when it was set.

A deadline rather than "the height stopped moving", because the height stopping
is what cannot be trusted here: a group sits at its estimate for a few frames and
then jumps, and an open that ended on that plateau handed the correction straight
back to the paths it was covering for.

**One rule ends it: the view is at a position the hook did not write.** A
scrollbar drag, a PageDown, a wheel and a touch drag all reach it through the
same test, at the moment they take effect — the loading gap included, where the
card can be taller than the viewport and reading its first paragraph means
scrolling up. A gesture that moves *nothing* — a momentum tick left over from the
conversation just left — is not the reader taking the view, which is why the
position decides and the gesture does not. Two earlier cuts got this wrong in
both directions: one let a gesture decide the open by a different route from the
scroll it produced, so the same action decided it differently according to
delivery order; the other exempted the gap outright and so fought a reader who
had done nothing but scroll a card.

**Hydration is not an append.** `appendedUserMessage` is the strongest exception
in the hook — it overrides the follow flag *and* clears gesture state — and it
read the arrival of a whole history whose last row happens to be the user's as
"they have just sent something". Opening a session that is mid-turn, before its
first reply, therefore threw a reader who had scrolled the loading card back to
the end, on the strength of a message they sent before they opened it. It now
requires a conversation to have been on screen already. The confusion is older
than this change; the reader promise above is what made it visible.

**A text selection is never suspended and never cleared here.** It stands every
pinning path down during an open exactly as at any other moment — the settle
loop included, which never asked, so a loop already running could walk content
out from under text selected after it started. That is older than this change and
is fixed with it. Only the session *switch* clears a selection, and only because
the conversation it was made in has gone; an earlier cut also cleared one at the
arrival commit, and review caught that the card a selection is usually in is
content that stays on screen.

**This is not the card's defect.** With the setting off the gap position is 0 and
the same failure reads the same way; the card is what makes the gap position
non-zero, which is why it correlates without being the cause.

Guard: `session-open-settle.test.tsx`, which models `scrollHeight` in two stages
— placeholder until the transcript is painted, laid-out afterwards — because the
two stages are the defect. Every part of the change is red on its own under some
case, here or in `useMessageScroll.test.tsx`; nothing is carried as consistency.
Both files say what they cannot fail on: deadline expiry and the settle cap,
which the new fixture's frames never deliberately cross; `CompactLayout`'s
competing writes, which need row rectangles jsdom has none of; scroll anchoring;
Chrome's own choice of when a group paints. Four things were written and then
**removed** for being unfalsifiable — two `CompactLayout` guards (the view is
short of the bottom only between a growth and the resize that corrects it, and
those are the same frame), the layout effect's own bypass of a stale gesture and
the settle loop's (the observer reaches both a frame later), and a `pinnedTopRef`
reset at the switch that the same effect's pin immediately overwrites. Two
existing cases in `useMessageScroll.test.tsx` advance the clock past the hold for
a fixture reason rather than a behavioural one: their geometry is installed after
mount, so the pin records a 0 that their own "scrolled away" position equals by
accident.

**And `session-open-scroll.test.tsx`'s own claim narrowed, which its preamble now
says.** When the first fix shipped, removing the follow flag or either gesture
ref turned one of its cases red. The observer's opening branch now covers for
those removals a frame later, so only the selection clearing still fails a case
there on its own. The resets stay because the open's invariant rests on them: it
holds only while the follow flag is true across a switch.

### A card that waits for an answer goes last (req 32)

The status card is not moved for this; the **answer card is lifted out of the
transcript's chunking and appended at the end of the flow**, after the status
card. `pendingAnswerElementIndex`
(`src/client/components/MessageList/pending-answer.ts`) returns the index of the
element that renders it, or `null`:

- It scans `visualElements` from the end, stepping over trailing **card rows** —
  a message element whose message has no text, no images, no files and no tools,
  and carries one of `CARD_MESSAGE_FIELDS`. A voice note is exactly that, which
  is why it stops being the thing the view lands on. It steps over a trailing
  **task panel** and a trailing **sub-agent chip** for a different reason:
  `buildVisualElements` folds both out of a message and emits them *after* the
  element for that message, so an agent that updates its to-do list or spawns a
  sub-agent in the same message as the question leaves one below the question.
  Both move down the transcript by design, so neither is the end of the
  conversation any more than a card row is.
- The first element that is none of those qualifies when it carries an
  **unanswered** `AskUserQuestion` (well-formed: an array of `questions`) or
  `ExitPlanMode` — a tool block with no `toolResults` entry of its own. Those are
  the two that end a turn waiting for the user; a permission or egress prompt
  blocks *inside* a turn, where req 30 already holds the status card above it.
  A row carrying more than one is pending while **any** of them is unanswered,
  and its identity is the first, which does not move when a second arrives.
- A question the agent asked, that the user then replied past, is not lifted:
  the user's own row is not a card row, so the scan stops there.
- A **`message` element with `hideTools`** never claims the card, even when its
  message carries the tool. A question beside a groupable tool is split into a
  prose row with the tools hidden and a standalone element for the question, and
  claiming both would give two siblings the same container key.

**Every answer card gets a container of its own, keyed by its tool** —
`qa-<toolUseId>`, a sibling of the row groups rather than a row inside one —
whether or not it is the pending one, and `answerCardElements` is what finds
them all. That is the load-bearing decision, and it is not decoration. React can
only move a node between parents by unmounting it, and `AskUserQuestion` keeps
the user's selections and their typed "Other" answer in component *state*: an
interrupted question never receives a tool result, so that state is the only
record there is of the answer. Give the pending card a container that appears
when it is pending and disappears when it is not, and answering the question
destroys the answer — `compact-conversation.test.tsx`'s "does not discard an
answer typed into a question when its turn collapses" is the standing contract
for exactly that, and it is what caught the first attempt here. With the
container keyed by the tool, the card's parent never changes: pending, it is the
last entry of the flow; not pending, it is an entry at its own position; and the
move between the two is a reorder among siblings of the scroll content.

**The chunk split generalises, and it happens at EVERY answer card** — the
pending one included, which renders elsewhere. A group is keyed by the chunk of
`ROWS_PER_GROUP` rows it belongs to, and the status card's anchor could already
split one chunk in two (req 30). An answer card splits a chunk the same way, and
a chunk can now be split more than once, so the `openedByCard` flag becomes a
`chunkSplits` counter and the suffix names the piece (`b1`, `b2`, …). It resets
at every real chunk boundary, so removing a split re-parents only the rows in
the pieces after it, inside that one chunk, and leaves every later chunk alone.

Two details there are load-bearing, and both were found by review rather than by
reading the happy path:

- **Splitting only for the NON-pending card would move the boundary as the
  question is answered**, so the rows just under it change group — and one of
  those rows is the transcript's own follow-up action card, which would lose the
  ticks the user had just made (req 19). Splitting unconditionally makes the
  boundary the same in both states.
- **The chunk the open group belongs to is tracked, not recomputed from
  `anchorsSeen`.** A split that lands exactly on a boundary opens the next
  chunk's first piece; a movable row (a task panel) can then sit in it, and
  `anchorsSeen % ROWS_PER_GROUP === 0` stops meaning "no group of this chunk has
  been opened yet". Reading it that way emitted two groups under one key — twice,
  in two different sequences. So `chunkIndex` and `chunkPiece` are carried: a
  non-movable row whose chunk differs closes the group and resets the piece, and
  a split only ever increments the piece.

**Document order stops being row order**, and one place read the two as the same:
`CompactLayout`'s anchor search walked `[data-compact-content]` in the DOM and
indexed the visibility string by that position. With an answer card rendered at
the end whatever its place in the transcript, the rows after it are off by one,
so the search can skip the wrong row. It now reads the row off the node's
`compact-row-N` id, which every row already carries for the re-parent lookup, and
falls back to the position for a node without one.

**The status card's own placement is untouched.** Idle, it is pushed at the end of
the flow exactly as before (req 6), and the pending answer card follows it;
during a turn it sits at the frozen anchor (req 30). The two rules compose
without either knowing about the other: the card leaves the view as the turn
writes, returns to the end when the turn stops, and the answer the user has to
give is still the last thing below it. Its offers are unaffected — a turn can end
with a question while the card offers actions, and both are reachable, the
question last because it is what holds the session up (req 32).

## Evolving the action card (req 19, 21)

- With the flag on, `propose_actions` is absent from every tool list, so no
  description of it reaches the model (req 21), and its route
  (`api-routes-propose-actions.ts`) answers 409 naming `session_status`, so
  a resident process from before a toggle cannot post a transcript card.
  With the flag off, tool, route, validator and prompt section are untouched.
  No alias: a callable alias would carry the old tool's own instruction to
  call it and end the turn (`propose-actions.ts:87`, advertised by
  `mcp-shipit-bridge.ts:50`), producing an extra nudge every time.
- Old `actionChecklist` rows in history keep rendering and submitting.
- **Acceptance.** `handleSendMessage`'s `checklistAccepted`
  (`send-message.ts:147`) stamps an old card `submittedAt` on every
  acceptance path. It is extended to call `takeOfferedActions` for
  `sessionStatusOfferIds` — and moved, on the busy path, to after the
  `enqueue` succeeds (`send-message.ts:295` calls it before, and a full queue
  can still refuse: `turn-accumulator.ts:26`), so a refused message never
  marks an offer taken. The callback stays synchronous; the serialized write
  is chained, not awaited.

## Prompt (req 5, 20, 25)

A "Session status" section in `src/server/orchestrator/prompts/skeleton.md`
that **replaces** the "Proposing optional follow-up actions" section in the
flag-on variant. It is part of the system prompt ShipIt injects, so the
agent has it on every turn without loading anything (req 25); a skill with
a longer treatment may come later and is not part of this design. It says:
the three fields and the action list; that `lastTurn` is the one line about the
turn, and the one field that is not a delta, so a call that omits it clears it
(req 31); the status describes the session, not
the turn; call it as the last act of a turn, and call it bare when nothing
changed (req 14); a turn ending in a question needs no call; "Needs you" is what only the user
can do by hand, an action is agent work approved with a click; offers
persist — add to them, replace them when no longer relevant or when the user
asks, drop taken ones once done; reviewing or merging the PR is ShipIt's
default workflow and never an offered action — say "ready to merge" in
Status; and, carried over from the old section, no routine command
shortcuts (run the tests, lint) as offers, and a choice that needs discussion
is a question, not an offer (CLAUDE.md §5). The tool description repeats the
rules in brief. Tests assert the section is present in the flag-on variants
and absent in the flag-off ones, never its wording.

## The card reaches the agent every turn (req 35)

The card was asked for and never shown. `agent-instructions.ts` reads the
setting only to choose which section of the injected prompt to render
(`:83`); no path put the stored card's own contents into a turn, and the nudge
carried the offer *labels* and their taken state alone. So the agent was
maintaining state it could not read, and both symptoms Nik reported follow from
that: a bare confirmation is the only honest call available to an agent that
cannot see what it is confirming, and an entry it has forgotten exists cannot be
dropped.

**The channel: the per-turn agent prefix.** Every turn's prompt is composed in
exactly two places — `runAgentWithMessage` (`ws-handlers/agent-execution.ts`)
for an interactive turn and `runDispatchedTurnInner` (`dispatched-turn.ts`) for
a dispatched one — and each joins an `agentPrefix` of notices ahead of the user
text. The card block joins that list, **last**, immediately before the user's
message: the one-shot notices keep their place at the top, and the ambient
state sits nearest the work.

Why this channel and not another, checked against the two properties req 35
names:

- **Every harness.** The prefix is message text. It reaches the CLI through the
  same prompt string on all five adapters, so nothing per-harness is needed and
  nothing can be missed for one of them — unlike `SHIPIT_SESSION_STATUS_CARD`,
  which had to be threaded through five adapter tool lists and two Claude
  allowlists.
- **A resident agent.** A process that outlives its turn is *sent the next
  message* and builds no run params (`turn-executor.ts`, Claude's shortcut in
  `agents/claude/adapter.ts`), which is why the setting itself needs the
  retirement machinery under "Setting". The prompt is the one thing such a turn
  does still carry, so the card rides it with no retirement at all.

**Two turns carry no prompt of ShipIt's, and the nudge is what covers them.**
Found by review, and stated here rather than built around:

- A **CLI-started turn** — a resident Claude that starts a turn of its own when a
  background task completes — is *adopted* (`turn-executor.ts`,
  `adoptInFlightTurn`). ShipIt composed no prompt for it, so there is nothing to
  put the card in.
- A **native `/goal` command turn** (docs/297) is delivered verbatim, because the
  harness reads it as a command only when the prompt is exactly the command.
  Every other prefix entry is excluded there for the same reason.

Both are still checked for a status update, so a turn of either kind that does
not write the card is nudged — and the nudge carries the card. The agent is
therefore never asked to reconcile the card without being shown it; on these two
paths it is shown it one turn later, by the turn that does the asking. That is
what req 35's last sentence covers, and it needs no mechanism of its own.
- **Not the system prompt.** It renders once at module load into a frozen
  per-variant constant and the CLI string must stay byte-stable
  (`prompt-architecture`); per-session content there would cost a cache miss
  every turn.
- **`pendingAgentNotice` is the precedent for the shape, not the mechanism.**
  It is a *take*: consumed by the turn that carries it, so it rides exactly one
  turn. The card is standing state and must ride every turn, so it is read and
  never consumed — which also means no re-parking path (`dispatched-turn.ts`
  keeps one for the notice) and nothing to lose when a dispatch fails setup.

**When nothing is sent.** The block is empty — the prefix is byte-for-byte
today's — when the setting is off, when the session has no stored card (req 22:
a new session sends nothing at all), and on the turns the other prefix entries
already skip: compaction, whose prompt is an instruction to summarise, a
verbatim goal command, which the harness reads only when the prompt is exactly
the command, and a `postTurn: "none"` driver-owned turn, which is never checked
for an update either. **And on the nudge turn**, whose own prompt carries the
same block; sending both would print the card twice in one prompt.

**What it contains, and what it costs.** `formatSessionStatusContext`
(`services/session-status.ts`) renders the status, the manual steps, and every
offer with its `id`, label, description and whether it has been sent — the
whole of what req 35 asks the agent to reconcile.

- **The offer payload is included**, though it is the one long field. Dropping a
  finished offer while keeping the others means sending the others back with
  `replaceActions: true`, and an offer whose payload differs by a byte arrives
  as a *new, untaken* offer. Listing the payload is what makes that a copy
  rather than a reconstruction.
- **`lastTurn` is deliberately absent.** It describes the turn that produced it,
  every write rewrites or clears it (req 31), and showing the previous turn's
  line invites carrying it forward — the one thing req 31 rules out. Freshness
  is absent for the same reason: the agent is being asked to reconcile the
  card's contents, and whether it currently reads stale changes none of them.
- **The cap is 8000 characters** (`MAX_STATUS_CONTEXT_CHARS`), and **it falls on
  the payloads, not on the offers**. The fixed part is already bounded by the
  field limits the validator enforces — `status` 1200, ten `needsYou` entries of
  240 — so only the offer list, which has no count limit (req 18), can grow. The
  block is rendered at the fullest detail that fits: every payload, then none,
  then no descriptions either, and only when the ids and labels alone will not
  fit does the listing itself shrink. Dropping offers first would be the wrong
  order twice over — req 35 asks that the agent see *each* offer, and an offer it
  cannot see is exactly the one a `replaceActions` would silently drop. So
  whenever the listing is anything less than complete the block says so and tells
  the agent not to replace the list that turn: a large card costs reconciliation
  power, never offers. **No field is ever truncated mid-value**: a half-printed
  payload is one the agent would echo back as a changed offer, which silently
  re-creates the offer it meant to keep.
  A worst-case card therefore costs about 2k tokens a turn; a real one costs a
  few hundred. The cost accumulates in a long conversation — each turn's copy
  stays in the history behind it, as every per-turn notice does — which is the
  other reason the cap is on the block rather than on the stored card.

**The nudge asks for a reconciliation, not a call** (`prompts/status-card-nudge.md`).
It carried the offer labels and asked for "one `session_status` call and nothing
else" — which is a fair description of the empty confirmation Nik was getting
back. It now carries the same rendered block through a `{{CARD}}` token and asks
the agent to go through it line by line: is this manual step still outstanding,
is this offer still worth offering, has it been done. The turn is still one call
and nothing else (req 15's budget is unchanged); what changed is what the call is
asked to contain.

**Wiring.** `SystemTurnDeps.sessionStatusContext?: (sessionId) => string` — the
gate and the read together, so a dispatched turn needs neither the session
manager nor the credential store — is wired at the two sites that already supply
`statusCardEnabled` (`runner-registry-factory.ts`, `ws-handlers/agent-execution.ts`)
from the shared `sessionStatusTurnContext` helper, which `runAgentWithMessage`
calls directly.

## Tests

Names below are the design's; where the build put a test somewhere else, the
built file is named in brackets. Every one of them exists.

- `session-status-validation.test.ts` — `lastTurn` trimmed, an empty one read as
  no line, its cap below the status's; limits; a bare call is valid;
  `needsYou: []` is a clear; empty list only with `replaceActions`; items
  through `validateActionItems`.
- `services/session-status.test.ts` — reconciliation (unchanged item keeps
  `offerId` and `takenAt`; changed payload → new untaken offer; replace;
  clear); `takeOfferedActions` with an unknown id marks nothing; `writeSeq`
  moves only on agent writes; `markSessionStatusStale` with an old
  `writeSeq` is a no-op; writes serialize per session; `lastTurn` rewritten by
  each write and dropped by one that omits it, the bare confirmation included
  (req 31); the nudge decision
  table on a snapshot (each "no" condition; plain turn → nudge).
- `api-routes-session-status.test.ts`
  [`integration_tests/session-status-route.test.ts`] — validate → persist → broadcast →
  `statusUpdated`; a bare call with a stored card → current, `writeSeq`
  moved, nothing else changed; a bare call with no stored card → 400
  naming `status`; 409 without a runner; the reply lists offers; the last-turn
  line carried through and dropped by the next write, the bare one included
  (req 31).
- `api-routes-propose-actions.test.ts`
  [`integration_tests/propose-actions-route.test.ts`] — 409 under the flag;
  unchanged otherwise.
- `prepared-dispatch.test.ts`, `queue-drain.test.ts` — `statusNudge` and
  `silent` survive `toQueuedMessage` → `queuedMessageToDispatchOptions`.
- `integration_tests/dispatched-turn-race.test.ts` — a dispatched turn retires a
  resident spawned with the other value of the setting.
- `integration_tests/restart-turn-adoption.test.ts` — through a real worker: an
  adopted ordinary turn with no update is nudged and the nudge it starts leaves
  the marker on the worker; an adopted turn that carried the marker is not
  nudged again.
- `turn-status-settlement.test.ts` — the settlement and the nudge driven
  through the real executor: stale at once and one nudge on a plain turn; the
  nudge turn not nudged again; no nudge and no stale mark after a compaction the
  user asked for or one ShipIt started, while a wrapped compaction command and a
  turn the CLI starts after a compaction are both checked (req 36); no nudge
  after a question, a crash, a `postTurn: "none"` driver turn, or with the
  setting off; a
  queued successor deferring with nothing left in the queue; a streaming
  `agent_result` + `done` giving one nudge; a predecessor's late exit leaving
  the successor's card current.
- `sessions.test.ts` — `lastTurn` through the column and back, and a card
  stored before the field existed read as one with no line (req 31);
  `integration_tests/rewind-fork.test.ts`,
  `services/session-fork-merge.test.ts` — the lifecycle marks.
- `send-message.test.ts` — offers taken after admission on each path, not
  on a refused enqueue; old cards still get `submittedAt`.
- `settings.test.ts` [`integration_tests/settings-derivation.test.ts`] — the
  save hook fires on false → true, and the toggle hook in both directions;
  the sweep itself is `services/session-status.test.ts`
  (`markAllSessionStatusesStale`) and the resident retirement is
  `resident-spawn-guard.test.ts`.
- Integration (`integration_tests/session-status-nudge.test.ts`, FakeClaude):
  the whole path in one tree, asserted as the outcomes a viewer can see — a turn
  without the call → stale at once, one dispatched follow-up whose user row
  starts with `[ShipIt]`; the follow-up calls the tool → fresh, nothing after it;
  a follow-up that skips it → no third turn; a question turn → no follow-up; a
  queued successor → deferred, with nothing queued behind it, and that turn
  checked afresh; a streaming `agent_result` + `done` → exactly one follow-up
  spawned; a predecessor exiting long after a later turn wrote → the card stays
  current; a resident agent spanning a toggle → retired and respawned with the
  other prompt and no spawn flag; flag off → no card, no mark, no follow-up, and
  a card stored before the toggle left untouched. The races underneath those
  outcomes — the deferral decision, the settlement snapshot, the `writeSeq`
  guard — are pinned where they are decided, in `turn-status-settlement.test.ts`
  and `services/session-status.test.ts`; this file demonstrates the outcome, not
  the mechanism. The per-harness flag-off tool lists are byte-for-byte in
  `mcp-tool-spec.test.ts` and each adapter's `mcp-writer.test.ts`, which is where
  the spec is chosen.
- `MessageList.test.tsx` [`src/client/components/MessageList.test.tsx`] — the card renders after the last transcript row
  inside the scroll content, and not at all without a stored status. Req 30:
  while a turn runs the card keeps its place and the turn's rows — the user's
  own message included — render below it; the turn stopping puts it last again;
  the move does not remount it, so an offer ticked before the turn is still
  ticked after and a submitted one stays greyed and tagged through the move and
  back; a viewer joining mid-turn anchors at the end of what it has; the empty
  transcript a session switch leaves behind is not an anchor; a streaming reply
  renders below the card; a tool group straddling the boundary falls below it;
  and a group past the card's own keeps its DOM node when the anchor moves.
  Req 32: a turn ending with a question puts the voice note and the status card
  above it and the question last; the same with offers on the card, and the same
  with no card stored at all; the question is not remounted when the voice note
  lands after it, nor when the conversation moves past it, so a typed answer
  survives both; a trailing follow-up action card keeps its ticks when the
  question is answered; every group keeps a distinct key when an answer card
  splits a chunk exactly on a boundary; a question the user replied past is left
  where it is.
- `MessageList/CompactLayout.test.tsx` — a row's visibility is read off its id
  rather than its place in the DOM, which req 32 separates; the reading anchor is restored when
  the card's anchor moves with the visibility string unchanged, under the
  card's own guard rather than the auto-follow one; and the anchor row is
  re-found when the reflow remounted it.
- `MessageList/hooks/useMessageScroll.test.tsx` — `canPreserveAcrossCardMove`
  asks the container, so a dispatched turn's user row arming auto-follow does
  not suppress it, and a reader at the bottom is left alone.
- `MessageList/pending-answer.test.ts` — the question the conversation ends
  with, found past a trailing voice note, a trailing task panel and a trailing
  sub-agent chip, and inside a message that also carries the agent's prose;
  claimed exactly once when that message also carries a grouped tool; pending
  while any of two questions on one row is unanswered; a plan waiting for
  approval; and `null` for an answered question, one the user replied past, a
  malformed one, and an ordinary conversation (req 32).
- `SessionStatusCard.test.tsx` — the last-turn line above the status with both
  labelled, and hidden on a stale card (req 31); the markdown status; the two subtitles; the
  manual-step toggles and their "I've done this" names; "Stale" only when
  stale; selection keyed by `offerId` survives a replacement as a new
  unselected item; a sent row greyed, unticked, tagged SENT and still tickable;
  stale card's offers selectable; submit carries `sessionStatusOfferIds` and
  per-offer provenance, and rides with the reported steps; a step submitted
  alone carries no offer ids. Req 37, one guard per state the row can be in:
  the field absent until the control is pressed and opening it ticking nothing;
  a note on an unticked step sent as an answer and on a ticked one as a detail;
  each note under its own step when several go at once; an answered step greyed
  and its note cleared; a refused submit keeping the note AND the retry sending
  the same message; the field surviving a blur, empty or not, and a Submit
  pressed with an empty one open still submitting; the control closing the field
  and dropping the note; a note of whitespace marking and sending nothing; a new
  note on a sent row reading ANSWERED beside SENT; the note carried into "Add
  comment…"; two identical steps each carrying their own note through to the
  message; the control outside the label, which is where the browser's rule can
  be seen (jsdom forwards no label activation); and no note control on an offer.
- `ActionChecklist.test.tsx` — `renderTrailing` and `renderBelow` rendered
  outside the label and inside the row's tint, neither present when the caller
  supplies neither, and `tag` shown beside the label on a taken row as well.
- `action-checklist-message.test.ts` — the done/answered split, a step that is
  neither dropped, the marker leading whichever block is first and appearing
  once, plural headings, and the two boundaries: every line of a multi-line note
  indented, a step's own text folded onto one line, and "Add comment…" composing
  by the same rule.
- `ActionChecklistCard.test.tsx` — unchanged behavior after the split.
- `agent-instructions.test.ts` — section present in flag-on variants, absent
  in flag-off ones.

**What the dogfood instance cannot show.** Local mode has no session worker, so
`LOCAL_SHIPIT_BRIDGE` is `null` (`local-agent-mcp.ts`) and **no** shipit MCP tool
reaches an inner agent — `session_status` and `propose_actions` alike. So an
inner turn can never satisfy the nudge (it answers that the tool is
unavailable), and every ordinary inner turn is nudged once. Everything around
the tool is observable there — the mark, the one visible follow-up turn, the
card, submission, the toggle — and the call itself is the route's own tests.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — the declaration; `src/server/orchestrator/services/settings.ts` — the save hook.
- `src/server/session/mcp-tools/session-status.ts`, `src/server/session/mcp-shipit-bridge.ts` — the tool and its registry entry.
- `src/server/session/agents/*/adapter.ts`, `src/server/session/agents/claude/process.ts`, `src/server/session/mcp-config-controller.ts`, `src/server/shared/types/agent-types.ts` — tool lists, allowlists and the flag in the config context and spawn env.
- `src/server/session/mcp-tool-spec.ts` — `shipitToolSpec`, the one place the offer tool id is chosen, so each harness keeps its own order and the flag-off spec stays byte for byte.
- `src/server/orchestrator/ws-handlers/agent-execution.ts`, `src/server/orchestrator/dispatched-turn.ts` — resident reuse check against the flag, one helper for both.
- `src/server/session/agent-controller.ts`, `src/server/orchestrator/turn-adoption.ts`, `src/server/orchestrator/proxy-agent-process.ts` — the nudge marker on the worker's in-flight turn info, and back onto the adopted turn.
- `src/server/orchestrator/resident-spawn-guard.ts` — `releaseResidentOnStatusCardChange` and the per-process record of the value it was spawned with.
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/orchestrator/api-routes-session-status.ts` — the route; `api-routes-propose-actions.ts` — refuses under the flag.
- `src/server/shared/session-status-validation.ts`, `src/server/shared/propose-actions-validation.ts` — envelope; shared `validateActionItems`.
- `src/server/orchestrator/services/session-status.ts` — record, stale, take, reconciliation, `shouldNudgeForStatusCard`, `statusNudgePrompt`.
- `src/server/orchestrator/turn-executor.ts` — `settleTurnFacts`, the memoized decision, dispatch from `finishTurn`; `harnessCommand` and `statusNudge` on `TurnInput`.
- `src/server/orchestrator/prepared-dispatch.ts`, `src/server/orchestrator/session-runner.ts` (`toQueuedMessage`, `QueuedMessage`), `src/server/shared/types/agent-types.ts` — the dispatch option.
- `src/server/orchestrator/turn-accumulator.ts` — `statusUpdated`.
- `src/server/orchestrator/ws-handlers/send-message.ts` — acceptance after admission.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts`, `src/server/orchestrator/services/session-fork-merge.ts` — stale on rewind, copy-as-stale on fork.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts`, `src/server/shared/types/domain-types/session.ts` — column and type.
- `src/server/orchestrator/prompts/skeleton.md` (the `{{FOLLOW_UP_ACTIONS}}` slot), `prompts/propose-actions.md`, `prompts/session-status.md`, `src/server/orchestrator/agent-instructions.ts` — the two variants.
- `src/client/components/SessionStatusCard.tsx`, `src/client/components/ActionChecklistCard.tsx`, `src/client/utils/action-checklist-message.ts`, `src/client/components/MessageList/MessageList.tsx` — the element, the shared checklist, the wrappers, the render slot at the end of the conversation.
- `src/client/components/MessageList/pending-answer.ts` — which elements render a card the user answers, and which one the conversation ends with (req 32).
- `src/client/components/MessageList/hooks/useMessageScroll.ts` — follow-the-bottom state, reset on the displayed session (planning#595).

## Rejected alternatives

- **Claude Stop hook** for the nudge — Claude only; one universal mechanism
  was chosen.
- **`pendingAgentNotice` on the next user turn** — the card stays stale until
  the user acts (req 11).
- **Deriving the card from `runner.turnSummary` or a small-model call** — the
  last message is already on screen; a summarizer is not the agent's own
  knowledge.
- **A runner-level "nudge pending" flag** — consumed by a compaction turn or
  a racing user turn; identity travels with the dispatch instead.
- **An `idle` listener for the decision** — `idle` fires twice on the
  streaming path and once from worker reconciliation with no turn behind it.
- **An alias for `propose_actions` under the flag** — see "Evolving".
- **Opacity, colored rails, state words in a header, a transcript notice**
  for freshness — the label in the corner is what the user chose.

## Agent decisions

Choices the human did not state, made to close gaps the reviews named.
Each is reversible without touching a numbered requirement.

- The update flag is sticky within a turn: an agent that writes the card and
  then keeps working still counts as updated; ordering is not verified.
- Rewind and conversation reset mark the card stale rather than clearing it.
- A fork copies the parent's card, marked stale.
- Offer identity is server-owned; an unchanged item keeps its identity and
  taken state across a replacement, a changed one does not.
- Provenance (`offeredAt`, `headSha`) is per offer.
- A successor turn running or queued defers the check to that turn's end;
  `postTurn: "none"` driver-owned turns are not checked.
- The setting is global scope on the advanced tab.
- The status card has no single-button variant. (Its earlier "one Send, no
  comment shortcut" is withdrawn — Nik ruled the card extends the action card
  rather than reducing it, req 26.)
- A per-step note is client-side only: nothing stores it, so `needsYou` keeps
  its shape (a list of strings) and a step keeps its text as its identity.
- An answered step greys as a reported one: the agent has been told either way.
- Every tool field is a delta on the stored card: omitted means unchanged,
  `needsYou: []` clears; a bare call with no stored card is refused. `lastTurn`
  is the exception, for the reason req 31 gives.
- The last-turn line is hidden on a stale card rather than cleared from the
  record, so turning the card current again does not need a second write.
- The rule that a card waiting for an answer goes last is stated for the two
  cards that END a turn that way (question, plan approval), not for every
  blocking prompt: a permission or egress prompt blocks inside a turn, where the
  card is already held above it by req 30.
- A `session_status` call whose awaits straddle a turn reset still writes the
  card but does not set `statusUpdated`: the write is right either way, and a
  successor inheriting the credit would escape the nudge it is owed. The
  stopped turn is exempt through `wasInterrupted`, so the skipped flag costs
  nothing.
