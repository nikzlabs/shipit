---
issue: planning#550
title: Session status card — design
description: Behind a setting, one agent tool carrying status, needs-you and persistent offered actions; one session-record column; one pinned element just above the composer; a ShipIt-started follow-up turn when a turn ends without an update.
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
`agents/claude/adapter.ts:382`). So the runner records the flag value its
resident was spawned with, and the reuse decision
(`ws-handlers/agent-execution.ts:668`) treats a mismatch as "no existing
agent": the resident is ended with `killProcessTree` and the next turn spawns
fresh. A toggle therefore applies from the next turn on every harness.

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
| Pinned element just above the composer | `GoalChip` in `App.tsx` |
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
| `status` | required, ≤ 240 chars | What the session is about, how far it got, whether it is done or ready to merge, and agent work not yet started. The whole session, not the last turn. |
| `needsYou` | optional, ≤ 240 chars | The decision or hand action only the user can take. Empty when nothing. |
| `actions` | optional list; each item `id`, `label`, `description?`, `defaultChecked?`, `payload` (≤ 4000 chars) — the `propose_actions` item shape, validated by `validateActionItems`, extracted from `propose-actions-validation.ts` and shared | Agent work the user approves with a click. |
| `replaceActions` | optional boolean, default false | `false`: add the given items to the offered list. `true`: the given list becomes the offered list; an empty list clears it. |

An empty `actions` is valid only with `replaceActions: true`. There is no
count limit on offers (req 18); the length limits are the concision (req 2).

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
item's taken state, so the agent can keep or replace offers knowingly.

## Storage (req 10)

- `sessions.session_status` column, JSON
  `{ status, needsYou?, actions: OfferedAction[], fresh, writeSeq }`;
  `OfferedAction` is the item plus `offerId`, `offeredAt`, `branch?`,
  `headSha?`, `takenAt?`. Migration via `addSessionColumnIfMissing`
  (`database.ts`).
- `writeSeq` increments only on an agent status write. Freshness marks and
  taken marks change the record but not `writeSeq`; it is the guard the
  settlement step uses to tell "a later turn wrote" from its own mutations.
- `SessionInfo.sessionStatus?: SessionStatus` (`domain-types/session.ts`),
  read in `sessions.ts` `fromRow`, written by `SessionManager.setSessionStatus`.
- `services/session-status.ts`: `recordSessionStatus` (agent write, bumps
  `writeSeq`, sets `fresh: true`), `markSessionStatusStale(sessionId,
  ifWriteSeq)` (no-op when `writeSeq` moved), `takeOfferedActions(sessionId,
  offerIds)` (stamps `takenAt`; an unknown `offerId` marks nothing). Each runs
  inside `runStatusExclusive`, the `runGoalExclusive` chain copied from
  `agent-goal.ts:31`, and broadcasts `session_list` when something shown
  changed.

Because the value rides `SessionInfo`, every viewer, a reload, a switch and
an orchestrator restart show the same card with no extra request.

**Lifecycle.**

- New session: no card until the first write (req 22).
- Conversation reset and rewind (`clearAgentSessionId`, also reached from
  `rollback-handlers.ts:348`): keep status and offers, mark stale. After a
  rewind the card may describe work that is gone; "Stale" says so.
- Fork (`forkSession`, `session-fork-merge.ts`): copy the parent's card,
  marked stale. It is the fork's starting point.
- Archive: the row keeps the column; restore brings the card back.
- Toggle: see "Setting".
- Dismissal: the composer is the control (CLAUDE.md §5). "Drop the retry
  idea" is a message; the prompt tells the agent to answer with
  `replaceActions`, and to drop taken offers the same way once done.

## Turn settlement (req 11–15)

**One flag on `TurnAccumulator`**, `statusUpdated`, set by the route and
reset with the accumulator at turn start (`session-runner.ts:452`, reached by
interactive, dispatched and adopted turns: `turn-executor.ts:169`,
`dispatched-turn.ts:307`, `agent-listeners.ts:145`). A question needs no
flag: Claude's native `AskUserQuestion` and the MCP `ask` tool both reach the
interrupt at `agent-listeners.ts:616` (the worker synthesizes the tool_use in
`session-worker.ts` `registerAskEndpoint`), which sets `runner.wasInterrupted`;
plan approval sets the same flag.

**The facts are taken at settlement, before the drain.** `wasInterrupted`
and the accumulator are runner state that the drained successor resets
(`session-runner.ts:448`), and the successor starts before the network
post-turn work and `idle`. So a helper `settleTurnFacts()` runs first thing
on each of the four terminal paths CLAUDE.md invariant 2 names — the clean
`agent_result`, the abnormal `done`, the adapter `error`, the failed auth
heal (`turn-executor.ts:223`, `:524`) — before their `drain` step, and
adoption resets it where it resets the other memoized work
(`turn-executor.ts:756`). It does two things at once:

1. Copies `{ statusUpdated, wasInterrupted, receivedResult, silent,
   statusNudge, postTurn, writeSeq }` into an executor-local snapshot.
2. If the turn is not `silent` and `statusUpdated` is false, calls
   `markSessionStatusStale(sessionId, snapshot.writeSeq)` — immediately, so
   the card never reads as current between a missing update and the end of
   the network flow. The guard makes it a no-op if a later turn already
   wrote.

**The nudge decision** is a memoized step after `idle`, on the snapshot
alone. It says **no** when: `statusUpdated`; `wasInterrupted` (question,
plan approval, user stop); no `agent_result` (a crash has its own recovery);
`silent` (compaction); the turn was itself a nudge; `postTurn: "none"` (a
driver-owned turn); the record's `writeSeq` moved past the snapshot's; or a
successor is running or queued (a deferral, not an exemption — the check
repeats when that turn ends). Otherwise it dispatches the nudge.

**Dispatch.** Not during the post-turn hold: a completed system turn keeps
`systemTurnInProgress` until `finishTurn` (`turn-executor.ts:149`), and a
dispatch made before that queues behind it after the final drain has run
(`session-runner.ts:235`). The step therefore records the decision and
`finishTurn`, after clearing the hold, enqueues the nudge and runs the drain
entry (`input.drainNext()`). The nudge is a dispatched system turn, not
`silent`: its prompt is echoed as the turn's user row (`system_user_message`),
the reply follows, the post-turn flow runs as for any turn (req 12). The
prompt opens with `[ShipIt]`, says the last turn ended without a status
update, lists the current offers with their taken state, and asks for one
`session_status` call and nothing else.

**Identity.** `statusNudge: true` is a typed dispatch option on
`AgentDispatchOptions`, added to `AgentDispatchInit`,
`queuedMessageToDispatchOptions` (`prepared-dispatch.ts`, whose coverage
asserts catch an omission), **and** to `QueuedMessage` and the hand-written
`toQueuedMessage` (`session-runner.ts:317`), which the asserts do not cover
and which compaction uses (`dispatched-turn.ts:96`). It reaches `TurnInput`,
as does `silent`, which is not forwarded today (`dispatched-turn.ts:307`).

**Bound (req 15).** The step says no for a turn whose snapshot has
`statusNudge`. An ignored nudge leaves the card stale; the next ordinary turn
is checked afresh.

## Client (req 6–9, 14, 17, 18, 20, 24)

`SessionStatusCard` (`src/client/components/SessionStatusCard.tsx`), rendered
in `App.tsx` where `GoalChip` renders, between the message list and the
composer. Reads `currentSession.sessionStatus`; renders nothing without one.
`text-xs`, semantic tokens only, no header row:

```
Status      Billing service: routes and tests done; PR #212 ready to merge. Webhook not started.
Needs you   Add the Stripe test key in Settings → Secrets.
☑ Wire the Stripe webhook   ☐ Add retry on 5xx   ☐ Add a README section (taken, greyed)   [ Send ]   Stale
```

- `Needs you` is omitted when empty.
- **Freshness.** A current card is a regular card. A stale card carries the
  word **"Stale"** (`text-[11px] font-semibold text-(--color-accent)`) in its
  bottom-right corner; the last row keeps right padding so text never runs
  under it. No tooltip: its wording would be wrong after a toggle or a
  rewind, and the label is real text for assistive technology.
- **Actions.** The presentational checklist of `ActionChecklistCard` — items,
  selection, the Send button — is extracted into a shared piece; the
  existing transcript-row wrapper keeps its formatting, repeat-submission,
  delivery-failure and "Add comment…" behavior unchanged, and the pinned
  card gets a wrapper of its own. On the pinned card: selection is keyed by
  `offerId`; `defaultChecked` applies when an offer first appears; a taken
  offer renders in `--color-text-tertiary` with its checkbox disabled and
  unchecked, and leaves only when the agent removes it (req 17); untaken
  offers stay selectable while the card is stale (req 24); there is one Send
  and no comment shortcut and no single-button variant — a qualified
  approval is an ordinary message. Submit composes a message of the same
  shape as the transcript card's, with each offer's own `offeredAt` and
  `headSha` (offers outlive status writes, so provenance is per offer, not
  per card), and carries the ticked `offerIds` as `sessionStatusOfferIds` on
  `send_message`.
- Not on the sidebar row (req 7); not an input to `computeAttentionReason`
  (req 9). The field is on `SessionInfo`, so the sidebar could read it; it
  must not.
- The question card is a transcript row at the end of the list, above this
  element (req 8).

## Evolving the action card (req 19, 21)

- With the flag on, `propose_actions` is absent from every tool list and its
  route (`api-routes-propose-actions.ts`) answers 409 naming `session_status`,
  so a resident process from before a toggle cannot post a transcript card.
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

## Prompt (req 5, 20)

A "Session status" section in `src/server/orchestrator/prompts/skeleton.md`
that **replaces** the "Proposing optional follow-up actions" section in the
flag-on variant. It says: the two fields and the action list; the status
describes the session, not the turn; call it as the last act of a turn; a
turn ending in a question needs no call; "Needs you" is what only the user
can do by hand, an action is agent work approved with a click; offers
persist — add to them, replace them when no longer relevant or when the user
asks, drop taken ones once done; reviewing or merging the PR is ShipIt's
default workflow and never an offered action — say "ready to merge" in
Status; and, carried over from the old section, no routine command
shortcuts (run the tests, lint) as offers, and a choice that needs discussion
is a question, not an offer (CLAUDE.md §5). The tool description repeats the
rules in brief. Tests assert the section is present in the flag-on variants
and absent in the flag-off ones, never its wording.

## Tests

- `session-status-validation.test.ts` — limits; required fields; empty list
  only with `replaceActions`; items through `validateActionItems`.
- `services/session-status.test.ts` — reconciliation (unchanged item keeps
  `offerId` and `takenAt`; changed payload → new untaken offer; replace;
  clear); `takeOfferedActions` with an unknown id marks nothing; `writeSeq`
  moves only on agent writes; `markSessionStatusStale` with an old
  `writeSeq` is a no-op; writes serialize per session; the nudge decision
  table on a snapshot (each "no" condition; plain turn → nudge).
- `api-routes-session-status.test.ts` — validate → persist → broadcast →
  `statusUpdated`; 409 without a runner; the reply lists offers.
- `api-routes-propose-actions.test.ts` — 409 under the flag; unchanged
  otherwise.
- `prepared-dispatch.test.ts`, `session-runner.test.ts` — `statusNudge` and
  `silent` survive `toQueuedMessage` → `queuedMessageToDispatchOptions`.
- `send-message.test.ts` — offers taken after admission on each path, not
  on a refused enqueue; old cards still get `submittedAt`.
- `settings.test.ts` — the save hook marks stored cards stale on false → true
  and broadcasts.
- Integration (`integration_tests/session-status-nudge.test.ts`, FakeClaude):
  a turn without the call → stale at once, one dispatched follow-up whose
  user row starts with `[ShipIt]`; the follow-up calls the tool → fresh; a
  follow-up that skips it → no third turn; a question turn → no follow-up; a
  queued successor → deferred; streaming `agent_result` + `done` → one
  decision; a predecessor settling after its successor wrote → no stale
  mark, no nudge; a resident agent spanning a toggle → respawned with the
  other tool list; flag off → today's behavior, byte for byte, per harness.
- `SessionStatusCard.test.tsx` — rows; hidden `Needs you`; "Stale" only when
  stale; selection keyed by `offerId` survives a replacement as a new
  unselected item; taken offers greyed, disabled, unchecked; stale card's
  untaken offers selectable; submit carries `sessionStatusOfferIds` and
  per-offer provenance.
- `ActionChecklistCard.test.tsx` — unchanged behavior after the split.
- `agent-instructions.test.ts` — section present in flag-on variants, absent
  in flag-off ones.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — the declaration; `src/server/orchestrator/services/settings.ts` — the save hook.
- `src/server/session/mcp-tools/session-status.ts`, `src/server/session/mcp-shipit-bridge.ts` — the tool and its registry entry.
- `src/server/session/agents/*/adapter.ts`, `src/server/session/agents/claude/process.ts`, `src/server/session/mcp-config-controller.ts`, `src/server/shared/types/agent-types.ts` — tool lists, allowlists and the flag in the config context and spawn env.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — resident reuse check against the flag.
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/orchestrator/api-routes-session-status.ts` — the route; `api-routes-propose-actions.ts` — refuses under the flag.
- `src/server/shared/session-status-validation.ts`, `src/server/shared/propose-actions-validation.ts` — envelope; shared `validateActionItems`.
- `src/server/orchestrator/services/session-status.ts` — record, stale, take, reconciliation, the decision, the nudge prompt.
- `src/server/orchestrator/turn-executor.ts` — `settleTurnFacts`, the memoized decision, dispatch from `finishTurn`; `silent` and `statusNudge` on `TurnInput`.
- `src/server/orchestrator/prepared-dispatch.ts`, `src/server/orchestrator/session-runner.ts` (`toQueuedMessage`, `QueuedMessage`), `src/server/shared/types/agent-types.ts` — the dispatch option.
- `src/server/orchestrator/turn-accumulator.ts` — `statusUpdated`.
- `src/server/orchestrator/ws-handlers/send-message.ts` — acceptance after admission.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts`, `src/server/orchestrator/services/session-fork-merge.ts` — stale on rewind, copy-as-stale on fork.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts`, `src/server/shared/types/domain-types/session.ts` — column and type.
- `src/server/orchestrator/prompts/skeleton.md`, `src/server/orchestrator/agent-instructions.ts` — the two variants.
- `src/client/components/SessionStatusCard.tsx`, `src/client/components/ActionChecklistCard.tsx`, `src/client/utils/action-checklist-message.ts`, `src/client/App.tsx` — the element, the shared checklist, the wrappers.

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
- The pinned card has one Send: no comment shortcut, no single-button variant.
