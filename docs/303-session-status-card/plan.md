---
issue: planning#550
title: Session status card — design
description: One agent tool carrying status, needs-you and offered actions; one session-record column; one pinned element above the composer; a ShipIt-started follow-up turn when a turn ends without an update.
---

# Session status card — design

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md). Reviewed twice by ShipIt's configured reviewer
on 2026-09-14 — once before and once after the action card was folded in;
the findings that changed this design are named where they apply. Decisions
the human did not state are collected at the end, under "Agent decisions".

## Setting (req 21)

One declaration in the settings catalogue
(`src/server/shared/settings-catalogue/global-settings.ts`, the
`defineSetting` shape of `advanced.enableSubAgents`):
`advanced.sessionStatusCard`, tab `advanced`, scope `global`,
`bool({ default: false })`, label "Session status card", description: an
agent-written card above the composer with the session's status, what needs
you and the offered follow-up actions; while on, the agent offers actions
through that card instead of the follow-up-actions card. Off by default: Nik
wants to run it for a few days before releasing it.

The flag gates everything below at one point per surface:

| Surface | Flag on | Flag off (today) |
|---|---|---|
| Tools in `SHIPIT_MCP_TOOLS` | `session_status`, no `propose_actions` | `propose_actions`, no `session_status` |
| Prompt | the "Session status" section | the "Proposing optional follow-up actions" section |
| Post-turn | the `status-nudge` step runs | the step returns at once |
| Client | `SessionStatusCard` rendered | not rendered; transcript action cards as today |

The flag reaches the session side per turn, the way `SHIPIT_AUTO_CREATE_PR`
does (`src/server/session/agents/claude/process.ts:243` sets it on the spawn
env from the run params): a run param `sessionStatusCard` becomes
`SHIPIT_SESSION_STATUS_CARD=1` in the agent's environment, and each adapter
picks its tool list from it. So a toggle applies from the next turn, on
every harness, with no restart. The prompt has two variants, both rendered
once at module load and picked per turn by the flag — the prompt-cache
contract of the `prompt-architecture` skill, unchanged. Stored status and
offers survive a toggle: off hides the card, on shows it again.

## Shape

Four pieces, each one already has a precedent in the codebase:

| Piece | Precedent |
|---|---|
| Agent tool `session_status` | `propose_actions` (`src/server/session/mcp-tools/propose-actions.ts`), which it replaces while the flag is on (req 16, 19, 21) |
| Session-record column `session_status`, broadcast with `session_list` | `agent_goal` (docs/154, `services/agent-goal.ts`) |
| Pinned element above the composer | `GoalChip` in `App.tsx` |
| ShipIt-started follow-up turn | the dispatch path `wakeSessionWithTurn` uses (`wake-session.ts`, `dispatched-turn.ts`) |

Nothing goes into the transcript except the nudge turn itself, so none of the
persisted-card machinery (`emitChatCard`, `CARD_MESSAGE_FIELDS`, history
rehydration) is involved.

## The tool (req 4, 5)

`session_status` — id and name both `session_status`, in
`src/server/session/mcp-tools/session-status.ts`, in the `SHIPIT_MCP_TOOLS`
list of all five harness adapters (Claude, Codex, OpenCode, Grok,
Antigravity) while the flag is on, so it is the same tool everywhere.

Two plain-text arguments and an optional action list, validated in
`src/server/shared/session-status-validation.ts`. The per-item validation is
extracted from `propose-actions-validation.ts` into `validateActionItems`
and shared (req 19); the envelope rules differ (below), so the envelope
validator is not reused — review found it rejects an empty list and caps at
five, which "replace with nothing" and "replace with everything relevant"
both need.

| Field | Limit | Meaning |
|---|---|---|
| `status` | required, ≤ 240 chars | What the session is about, how far it got, and whether it is done or ready to merge — including agent work not yet started ("webhook not started"). The whole session, not the last turn. |
| `needsYou` | optional, ≤ 240 chars | The decision or hand action only the user can take. Empty when nothing. |
| `actions` | optional, each item the `propose_actions` item shape: `id`, `label`, `description?`, `defaultChecked?`, `payload` (≤ 4000 chars) | Follow-up agent work the user approves with a click (req 16, 20). |
| `replaceActions` | optional boolean, default false | `false`: add the given actions to the offered list; an item whose `id` is already offered replaces that item. `true`: the given list replaces the offered list; an empty list clears it (req 17). |

Actions are never cleared by a turn (req 17): a call without `actions`
leaves the offered list as it is. Only the agent changes the list —
`replaceActions: true` replaces it, an add with a known `id` replaces one
item. The user taking an action does not remove it: it stays, marked taken,
until the agent removes it (req 17). An empty `actions` is valid only with
`replaceActions: true`. The offered list holds at most
`MAX_OFFERED_ACTIONS = 10` items — a bound against a runaway agent, not a
design target (req 18 wants every relevant one shown); a call that would
exceed it is refused with a message naming `replaceActions`.

**Action identity.** The agent's `id` names an offer; the server gives every
stored item an `offerId` (uuid) when it is created or replaced. Everything
that acts on an offer — the checkbox, the submit, the removal — uses the
`offerId`. So a replacement that changes an item's payload gets a new
`offerId`, a submit composed before that replacement removes nothing and the
new offer stays, and a replacement can never resurrect an offer the user
already took. Review found this race unaddressed; `propose_actions` ids are
unique only within one card (`propose-actions-validation.ts:53`), which is
why the server owns the identity.

A `next` field was in the first draft and removed on 2026-09-14: the card
is read after the agent has finished, so everything "next" waits for the
user's go and either duplicates `status` or is a `needsYou`.

The limits are the concision (req 2): the agent cannot write a paragraph. A
`done` boolean was in the first draft and removed on review: `status` says
it in words, and nothing in the requirements asks for a glyph.

Call path: tool → worker `POST /agent-ops/session-status` (a `relay` line in
`agent-ops-routes.ts`) → orchestrator
`POST /api/sessions/:sessionId/session-status` (`containerAccessible: true`,
in a new `api-routes-session-status.ts`). The route validates, persists,
broadcasts, marks the current turn as updated (below), and answers with one
line telling the agent the status is on screen and it can end its turn.

## Storage and transport (req 10)

- `sessions.session_status` column, JSON
  `{ status, needsYou?, actions: OfferedAction[], fresh, version, branch?, headSha? }`,
  where `OfferedAction` is the item shape plus `offerId`, `offeredAt` and
  `takenAt?`.
  `version` increments on every write and is the guard the post-turn step
  uses (below). `branch`/`headSha` are captured at write time exactly as
  `api-routes-propose-actions.ts` does today, because the submit message
  (`formatProposalMessage`, `src/client/utils/action-checklist-message.ts`)
  carries that provenance. Migration via `addSessionColumnIfMissing`
  (`database.ts`), like `agent_goal`.
- `fresh` (req 14) means "the last finished turn updated this card". The
  route writes `fresh: true`; the post-turn step (below) writes
  `fresh: false` at the end of every settled turn that did not update it,
  whatever the reason — a question, an actions card, a user stop, a crash, an
  ignored nudge. Only a `silent` compaction turn leaves it alone: no work
  happened. One rule, two writers, no third state. A dispatched nudge leaves the
  card marked stale until the nudge turn writes; that is the honest reading of that
  window.
- `SessionInfo.sessionStatus?: SessionStatus` (`domain-types/session.ts`),
  read in `sessions.ts` `toRow`/`fromRow`, written by
  `SessionManager.setSessionStatus`.
- `services/session-status.ts` `recordSessionStatus(deps, sessionId, write)`,
  `markSessionStatusStale(deps, sessionId, ifVersion)` and
  `takeOfferedActions(deps, sessionId, offerIds)` (stamps `takenAt`, removes
  nothing): each runs inside
  `runStatusExclusive` (the `runGoalExclusive` chain from `agent-goal.ts`,
  copied — one status operation per session at a time), writes, then
  `sseBroadcast("session_list", …)` when something shown changed. The stale
  mark takes the `version` the caller observed and is a no-op if a newer
  write happened since; copying only the setter, as the first draft did,
  inherited neither the serialization nor the obsolete-write rejection the
  goal service has (review).

Because the value rides `SessionInfo`, every viewer, a reload, a session
switch and an orchestrator restart show the same card with no extra request.
Lifecycle (agent decisions, see the end):

- **Conversation reset and rewind.** `clearAgentSessionId` runs on a
  conversation reset and after a code/history rewind
  (`rollback-handlers.ts:348`). It clears `agent_goal`; here it keeps the
  status and the offers but marks them stale (`fresh: false`). The card's
  content is still the best summary the user has, and after a rewind it may
  describe work that is gone, which is exactly what "Stale" says. The next
  turn refreshes it.
- **Fork.** `forkSession` creates a new row (`session-fork-merge.ts:184`); it
  copies the parent's status and offers, marked stale. The fork starts from
  the parent's state, so the parent's card is the right first card, and the
  stale mark says it was not written for this session. Without the copy a
  fork whose first turn asks a question would have no card at all.
- **Archive.** The row keeps the column; archiving hides the session, and a
  restore brings the card back with it. Nothing to do.
- **New session.** No card until the first status write. A first turn that
  ends with a question leaves no card (req 13); the first ordinary turn
  writes one.
- **Dismissal and taken offers.** The user has no control on the card to
  drop an offer; ShipIt's control is the composer (CLAUDE.md §5). "Drop the
  retry idea" is a message; the prompt tells the agent to answer it with
  `replaceActions`, and to drop taken offers the same way once they are
  done. The agent reads the offered list back with each item's taken state:
  the route's reply to any `session_status` call, and the nudge prompt,
  include it, so a fresh context after a reset knows what is on the card.

## Turn-end accounting (req 11–13)

One flag on `TurnAccumulator` (`turn-accumulator.ts`), reset with the rest
of the accumulator at turn start (`session-runner.ts:452`; reached by every
turn kind — interactive, dispatched, adopted — verified at
`turn-executor.ts:169`, `dispatched-turn.ts:307`, `agent-listeners.ts:145`):

- `statusUpdated` — set by the session-status route.

An earlier draft had a second flag, `actionsProposed`, and an exemption for
a turn that ended with an action card. Since the actions are written by the
same tool (req 16), such a turn sets `statusUpdated` by definition, and both
are gone.

A question needs no flag of its own: both Claude's native `AskUserQuestion`
and the MCP `ask` tool arrive at the same interrupt (`agent-listeners.ts:616`,
`isWellFormedAskUserQuestion`; the worker turns the MCP call into an
`AskUserQuestion` tool_use event in `session-worker.ts` `registerAskEndpoint`),
and that interrupt sets `runner.wasInterrupted`. Plan approval (`ExitPlanMode`)
sets the same flag. So "the turn ended waiting for the user" is one existing
signal, read where the turn settles.

The flag is set on the orchestrator's own evidence — its route was hit —
never by matching tool names in the event stream, which differ per harness.

**A stated tolerance.** The flag is sticky within the turn: an agent that
updates the status and then does more work still counts as complete. The
prompt asks for the update as the last act; the orchestrator does not verify
ordering, because the route hits and the tool events arrive on different
channels and ordering them would be a mechanism nobody asked for. Both
reviews named it; kept as a known tolerance.

## The nudge (req 12)

**Decided inside the turn, not from the `idle` event.** The first draft hung
the nudge on `runner.on("idle")`. Review showed `idle` is not a once-per-turn
signal: the streaming path emits it at `agent_result` and again at `done`
(`turn-executor.ts:834`, `:946`), worker-state reconciliation emits it with no
turn behind it (`container-session-runner.ts:1860`), and a drained successor
can be running — or already finished — when a predecessor's late idle fires.
An idle listener would need a turn epoch to be safe; the executor already has
one.

So the decision is a memoized post-turn step in `turn-executor.ts`,
`status-nudge`, run after `idle` (memoized with `??=` like `runCommitAndPr`,
so the streaming `agent_result` and `done` paths call it once between them).

**Its inputs are a snapshot, taken before the drain.** The second review
showed that `runner.wasInterrupted` and the accumulator flag are mutable
runner state, not executor-local: `tryDrain` starts the successor before the
commit and the idle step (`turn-executor.ts:831`), and the successor's start
resets both (`session-runner.ts:448`). A step that read them later would
read the successor's turn. So at the moment the turn settles — the
`agent_result` handler, or the `done` handler on a no-result path — and
before `postTurnStep("drain", …)`, the executor copies into a `const`:
`{ statusUpdated, wasInterrupted, receivedResult, silent, statusNudge,
statusVersion }`, where `statusVersion` is the record's `version` at that
instant. The decision reads only that snapshot, and says **no** when:

- the status was updated (any `session_status` call, with or without
  actions);
- the turn was interrupted — a question, a plan approval, or the user
  pressing stop — or never reached `agent_result` (a crash has its own
  recovery paths; the agent did not finish a turn, so there is no turn end
  to check);
- the turn was `silent` (compaction) — `silent` is not forwarded into
  `TurnInput` today (`dispatched-turn.ts:307`); this change forwards it;
- the turn was itself a nudge (below);
- the record's `version` has moved past the snapshot's: a later turn
  already wrote, and this turn's verdict is obsolete;
- a successor is running or queued: this is a deferral, not an exemption —
  the card is checked again when that turn ends, and a nudge queued behind a
  user message would answer the wrong turn.

Otherwise it dispatches the nudge through the same entry the queue drain
uses, as a dispatched system turn — not `silent`, so the prompt is echoed as
the turn's user row (`system_user_message`), the agent's reply follows, and
the post-turn flow runs as for any turn. That is the transparency req 12 asks
for. The prompt opens with `[ShipIt]`, the prefix ShipIt already uses for
lines it writes into the conversation (bug-report resolutions), and says: the
last turn ended without a session status update; call `session_status` now
with the two fields; do nothing else. The prompt also lists the currently
offered actions, so the agent can keep or replace them knowingly.

**Nudge identity travels with the dispatch.** The first draft set a
`statusNudgePending` flag on the runner and consumed it at the next turn
start. Review showed that identifies the wrong turn: automatic compaction
queues the dispatch and runs a silent turn first (`dispatched-turn.ts:90`),
which would consume the flag, and a user turn admitted while the wake prepared
credentials (`wake-session.ts:75`) would consume it too. So the nudge is a
typed dispatch option, `statusNudge: true`, on `AgentDispatchOptions` — added
to `AgentDispatchInit` and `queuedMessageToDispatchOptions`
(`prepared-dispatch.ts`, whose field-coverage asserts make an omission a type
error) — carried through the queue and compaction into `TurnInput`, and read
by the `status-nudge` step of that turn.

**Bound (req 15).** One nudge per missing update: the step says no for a
turn whose input is `statusNudge`. An agent that ignores the nudge leaves the
previously written status on screen, marked stale (req 14) — the same mark a
question turn leaves. The next ordinary turn is checked afresh. A transcript
notice was in the second draft and is gone: the card says it itself, in the
language every stale card uses.

**The step is reachable from every terminal path, like `runCommitAndPr`
(CLAUDE.md invariant 2), and its first act on any non-`silent` turn whose
snapshot lacks `statusUpdated` is `markSessionStatusStale(…, snapshot.statusVersion)`.**
That is the second writer of `fresh`, and the version argument makes it a
no-op when a later turn has already written — so a slow predecessor can
never mark a newer status stale. Only the *dispatch* of a nudge needs
`receivedResult` and the other conditions above; the stale mark does not,
because a turn that ended by a question, a stop or a crash left the card
behind just the same.

Rejected on the way:

- **Claude Stop hook** (`docker/agent-hooks/stop-pr-check.sh`, docs/129) —
  Claude only; the user chose one universal mechanism at the ShipIt level.
- **`pendingAgentNotice` on the next user turn** — cheaper, but the card stays
  stale until the user acts, which req 11 rules out.
- **Deriving the card from `runner.turnSummary` or a small-model call** — the
  last message is already on screen (requirements, resolved 2026-09-14), and a
  summarizer is not the agent's own knowledge of the session.
- **A transcript `system_notice` when the nudge is ignored** — the second
  draft had one. With req 14 the card carries its own freshness in one visual
  language for every cause, and a notice for one cause would be a second
  language. Removed.

## Client (req 6–9)

`SessionStatusCard` (`src/client/components/SessionStatusCard.tsx`), rendered
in `App.tsx` in the column that already holds `GoalChip`, between the message
list and the composer. Reads `currentSession.sessionStatus`; renders nothing
until the session has one.

Layout, `text-xs`, semantic tokens only, no new theme values, no header row:

```
Status      Billing service: routes and tests done; PR #212 ready to merge. Webhook not started.
Needs you   Add the Stripe test key in Settings → Secrets.
☐ Wire the Stripe webhook          ☐ Add retry on 5xx          ☑ Update the API docs
                                                                          [ Send ]
```

- **Actions (req 16–19).** The offered actions render below the two fields
  as the checklist the action card already draws. `ActionChecklistCard`
  (`src/client/components/ActionChecklistCard.tsx`) splits into a
  presentational checklist (items, selection, "Send" / single button) and a
  wrapper that owns formatting and submission; the old transcript-row wrapper
  keeps its repeat-submission, delivery-failure and "Add comment…" behavior
  unchanged, and the pinned card gets its own wrapper. Two adaptations the
  second review required: selection is keyed by `offerId`, not by the
  agent's `id`, so a replaced offer arrives as a new, unselected item with
  its own `defaultChecked`, and the payload behind a ticked box can never
  change silently; and the pinned wrapper passes the card's stored
  `branch`/`headSha`/`offeredAt` to `formatProposalMessage`, which needs
  them. The "Add comment…" path carries the ticked `offerIds` too, so a
  qualified approval also marks what it approved. Submitting composes the
  same user message as today and starts a turn; on acceptance (below) the
  ticked offers are stamped taken and render greyed out and unselected, the
  unticked ones stay as they were (req 17). A taken offer cannot be ticked
  again; it leaves the card only when the agent removes it with
  `replaceActions`. Every offered action is shown (req 18).

- **Freshness (req 14).** Two states, no title text spent on them. A current
  card is a regular card. A card that may be behind carries a small
  **"Stale"** label (`text-[11px] font-semibold text-(--color-accent)`) in
  its bottom-right corner. The accent was chosen over the primary text color
  on 2026-09-14: it stands out from the card text and reads as a status
  signal. The last row keeps right padding so the label never overlaps text. The label doubles as the accessible signal (it is real text),
  and the card's `title` tooltip says "Stale: the last turn did not update it"
  for a pointer user. Opacity was tried first and rejected as barely visible.
  Both states are drawn on a light and a dark theme in
  [mockup.html](mockup.html).
- `Needs you` is omitted when empty.
- No button, no collapse: the limits keep it short (req 2), and the composer
  is the control.
- It does not appear on the sidebar row (req 7) and is not an input to
  `computeAttentionReason` (req 9). The field is on `SessionInfo`, so the
  sidebar *could* read it; it must not.
- The question card is a transcript row at the end of the message list, so
  it sits above this element and remains the last thing in the conversation
  (req 8). Action cards from before this change stay where history put them
  and keep working; new offers appear only on this card.

## Evolving the action card (req 19, 21)

`propose_actions` is replaced while the flag is on, kept intact while it is
off, and never aliased:

- **Tool.** With the flag on, `propose_actions` is left out of every
  harness's `SHIPIT_MCP_TOOLS` list and its `skeleton.md` section is swapped
  for the session-status section; with the flag off, both stay exactly as
  today. The tool, its route and its validator are not deleted. An earlier
  draft kept the tool callable under the flag as an alias that merged
  actions without a status; review showed the alias's own tool description
  still told the agent to call it and end the turn (`propose-actions.ts:87`,
  advertised by `mcp-shipit-bridge.ts:50`), so it produced a predictable
  extra nudge, and an alias call on a session with no status yet would store
  offers nobody could see. Gating by the tool list removes both problems: an
  agent under the flag cannot see the old tool.
- **Route.** `api-routes-propose-actions.ts` stays for the flag-off mode.
  Under the flag it answers 409 with a line naming `session_status`, so a
  stale process cannot post a transcript card while the card is on.
- **Validation.** `validateActionItems` is extracted from
  `propose-actions-validation.ts` and shared by both envelopes.
- **Renderer.** As in "Client" above: shared checklist, two wrappers. Old
  `actionChecklist` rows in history keep rendering and submitting; nothing is
  migrated or deleted.
- **Submit and acceptance.** Today `send_message.actionChecklistCardId` is
  consumed in `handleSendMessage`'s `checklistAccepted` callback
  (`send-message.ts:147`), which runs on every acceptance path — steered,
  queued and ordinary dispatch — and stamps the card `submittedAt`
  (`send-message.ts:55`). The pinned card's submit carries
  `sessionStatusOfferIds` on the same message, and the same callback calls
  `takeOfferedActions` for them. Marking on acceptance, not before and not
  at execution, is what review asked for: a refused message leaves its offers
  untaken, and a queued approval does not stay selectable while it waits.
  (docs/207's statement that a submission has no persisted lifecycle
  predates `submittedAt`; a note there points here.)

## Prompt (req 5)

A short "Session status" section in
`src/server/orchestrator/prompts/skeleton.md`, after "Proposing optional
follow-up actions". It says what the two fields and the action list are, that the status
describes the session and not the turn, that it is the last act of a turn,
that a turn ending in a question needs no update, that "Needs you" is what
only the user can do by hand while an action is agent work approved with a
click (req 20), and that offered actions persist — add to them, or replace
them when they are no longer relevant, including when the user asks to drop
one.
It also says what is **not** a next step: opening, reviewing or merging the
PR is ShipIt's default workflow, never a step to list — the status says
"ready to merge" instead. (Nik, 2026-09-14.)
The tool description carries the same rules in brief, for harnesses whose
system prompt is shorter. Static text, rendered once at module load — the
prompt-cache contract in the `prompt-architecture` skill holds. Tests assert
the section is composed in, not its wording.

## Tests

- `session-status-validation.test.ts` — limits, required fields, trimming,
  action items validated by the shared validator, an empty list only with
  `replaceActions`, the offered-list bound.
- `services/session-status.test.ts` — offer semantics: add, same-`id`
  replacement issues a new `offerId`, replace, clear; `takeOfferedActions` stamps `takenAt` and with a stale `offerId` marks nothing; writes serialize per session;
  `markSessionStatusStale` with an old version is a no-op.
- `api-routes-session-status.test.ts` — validate → persist → `session_list`
  broadcast → accumulator flag set; 409 when the runner is not active.
- `services/session-status.test.ts` — the decision table on a snapshot:
  updated / interrupted / no result / silent / nudge-itself / version moved /
  successor running → no; plain turn → nudge.
- `prepared-dispatch.test.ts` — `statusNudge` survives the queue round trip.
- Integration (`integration_tests/session-status-nudge.test.ts`, FakeClaude):
  a turn without the tool → exactly one dispatched follow-up whose user row
  starts with `[ShipIt]`; the follow-up calls the tool → card persisted and
  fresh; a follow-up that also skips it → no third turn, card marked stale; a
  turn that asks a question → no follow-up; a turn with a queued successor →
  no follow-up until the successor ends; the streaming `agent_result` + `done`
  pair → one decision, not two; a predecessor settling after its successor
  wrote → no stale mark and no nudge (the snapshot-and-version guard).
- `SessionStatusCard.test.tsx` — two rows, hidden `Needs you` when empty,
  the "Stale" label present only in the stale state, every offered action
  rendered, selection keyed by `offerId` survives a replacement as a new
  unselected item, submit composes the same message as the transcript card
  and sends the ticked `offerIds`, the comment path sends them too.
- `send-message.test.ts` — `checklistAccepted` marks the offers taken on
  each acceptance path and not on refusal; old cards still get `submittedAt`.
- `SessionStatusCard.test.tsx` also: a taken offer renders greyed out,
  unselected and not selectable; it disappears after a `replaceActions`
  write that omits it.
- `ActionChecklistCard.test.tsx` — existing behavior unchanged after the split.
- Flag tests: with `advanced.sessionStatusCard` off, the tool lists, the
  prompt, the post-turn step and the client are exactly today's (a snapshot
  of the tool list and the prompt section set per harness in both modes);
  with it on, `propose_actions` is absent and the route refuses; toggling
  applies on the next turn.
- `services/session-status.test.ts` also covers `fresh`: the route sets it,
  a question turn clears it, an ignored nudge clears it, a later update sets
  it again; the broadcast fires only on change.
- `agent-instructions.test.ts` — the section is present in every variant.

## Key files

- `src/server/session/mcp-tools/session-status.ts` — the tool.
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/orchestrator/api-routes-session-status.ts` — persist, broadcast, flag.
- `src/server/orchestrator/services/session-status.ts` — `recordSessionStatus`, the decision, the nudge prompt.
- `src/server/orchestrator/turn-executor.ts` — the memoized `status-nudge` post-turn step; `silent` and `statusNudge` on `TurnInput`.
- `src/server/orchestrator/prepared-dispatch.ts`, `src/server/shared/types/agent-types.ts` — the `statusNudge` dispatch option.
- `src/server/orchestrator/turn-accumulator.ts`, `session-runner.ts` — per-turn flags and their reset.
- `src/server/shared/settings-catalogue/global-settings.ts` — the `advanced.sessionStatusCard` declaration.
- `src/server/session/agents/*/adapter.ts`, `src/server/session/agents/claude/process.ts` — tool list and `SHIPIT_SESSION_STATUS_CARD` per turn.
- `src/server/orchestrator/api-routes-propose-actions.ts` — refuses under the flag; unchanged otherwise.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `checklistAccepted` also takes offered actions by `offerId`.
- `src/client/components/ActionChecklistCard.tsx`, `src/client/utils/action-checklist-message.ts` — split into the shared checklist piece and two wrappers.
- `src/server/orchestrator/ws-handlers/rollback-handlers.ts`, `src/server/orchestrator/services/session-fork-merge.ts` — stale on rewind, copy-as-stale on fork.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts`, `src/server/shared/types/domain-types/session.ts` — column and type.
- `src/server/shared/session-status-validation.ts`, `src/server/shared/propose-actions-validation.ts` — envelope limits; the shared `validateActionItems`.
- `src/server/orchestrator/prompts/skeleton.md` — the instruction.
- `src/client/components/SessionStatusCard.tsx`, `src/client/App.tsx` — the element.

## Agent decisions

Choices the human did not state, made to close gaps the reviews named. Each
is reversible without touching a numbered requirement; say so and it changes.

- A rewind or conversation reset marks the card stale rather than clearing
  it (req 14's meaning applied to a case req 14 does not name).
- A fork copies the parent's card, marked stale.
- A new session shows no card until its first status write; a first turn
  that ends with a question leaves none (req 13 applied to a fresh session).
- The offered list is bounded at 10 items as a safety limit.
- Offer identity is server-owned (`offerId`); the agent's `id` is a name for
  in-place replacement, not the identity.
- A successor turn running or queued defers the check to that turn's end.
- The flag is `global` scope on the `advanced` tab; a per-project flag was not
  asked for and would put the tool list on a second axis.
