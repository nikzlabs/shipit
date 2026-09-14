---
issue: planning#550
title: Session status card — design
description: One agent tool carrying status, needs-you and offered actions; one session-record column; one pinned element above the composer; a ShipIt-started follow-up turn when a turn ends without an update.
---

# Session status card — design

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md). Reviewed once by ShipIt's configured reviewer
on 2026-09-14; the findings that changed this design are named where they
apply.

## Shape

Four pieces, each one already has a precedent in the codebase:

| Piece | Precedent |
|---|---|
| Agent tool `session_status` | `propose_actions` (`src/server/session/mcp-tools/propose-actions.ts`), which it absorbs (req 16, 19) |
| Session-record column `session_status`, broadcast with `session_list` | `agent_goal` (docs/154, `services/agent-goal.ts`) |
| Pinned element above the composer | `GoalChip` in `App.tsx` |
| ShipIt-started follow-up turn | the dispatch path `wakeSessionWithTurn` uses (`wake-session.ts`, `dispatched-turn.ts`) |

Nothing goes into the transcript except the nudge turn itself, so none of the
persisted-card machinery (`emitChatCard`, `CARD_MESSAGE_FIELDS`, history
rehydration) is involved.

## The tool (req 4, 5)

`session_status` — id and name both `session_status`, in
`src/server/session/mcp-tools/session-status.ts`, added to the
`SHIPIT_MCP_TOOLS` list of all five harness adapters (Claude, Codex, OpenCode,
Grok, Antigravity), so it is the same tool everywhere.

Two plain-text arguments and an optional action list, validated in
`src/server/shared/session-status-validation.ts`, which reuses
`propose-actions-validation.ts` for the items (req 19):

| Field | Limit | Meaning |
|---|---|---|
| `status` | required, ≤ 240 chars | What the session is about, how far it got, and whether it is done or ready to merge — including agent work not yet started ("webhook not started"). The whole session, not the last turn. |
| `needsYou` | optional, ≤ 240 chars | The decision or hand action only the user can take. Empty when nothing. |
| `actions` | optional, each item the `propose_actions` shape: `id`, `label`, `description?`, `defaultChecked?`, `payload` (≤ 4000 chars) | Follow-up agent work the user approves with a click (req 16, 20). |
| `replaceActions` | optional boolean, default false | `false`: merge the given actions into the offered list by `id` (same id updates in place); `true`: the given list replaces the offered list, an empty list clears it (req 17). |

Actions are never cleared by a turn (req 17): a call without `actions`
leaves the offered list as it is. Only `replaceActions: true`, or the user
taking an action, changes it. There is no cap on the number of offered
actions beyond `MAX_ACTIONS` per call (req 18).

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
  `{ status, needsYou?, actions: ActionChecklistItem[], fresh }`. Migration via
  `addSessionColumnIfMissing` (`database.ts`), like `agent_goal`.
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
- `services/session-status.ts` `recordSessionStatus(deps, sessionId, status)`
  and `markSessionStatusStale(deps, sessionId)`: write, then
  `sseBroadcast("session_list", …)` when something shown changed, exactly
  `recordAgentGoal`.

Because the value rides `SessionInfo`, every viewer, a reload, a session
switch and an orchestrator restart show the same card with no extra request.
`clearAgentSessionId` (conversation reset) clears `agent_goal` and leaves this
column alone: the status is about the session, and a new thread does not
change what the session is about. A fork (`forkSession`) is a new row and
starts with no status; its first turn is nudged into writing one — unless
that first turn asks a question, in which case the fork has no card until
its first ordinary turn (req 13's exemption, applied to a fresh session).

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
updates the status and then does more work still counts as complete. The prompt asks for the update as the last
act; the orchestrator does not verify ordering, because the route hits and
the tool events arrive on different channels and ordering them would be a
mechanism nobody asked for. Reviewer finding, kept as a known tolerance.

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
`status-nudge`, run after `idle` on the paths that reached `agent_result`
(memoized with `??=` like `runCommitAndPr`, so the streaming `agent_result`
and `done` paths call it once between them). It reads executor-local facts —
`receivedResult`, `runner.wasInterrupted`, the turn's own `silent` and
`statusNudge` inputs, the accumulator flag — and says **no** when:

- the status was updated (any `session_status` call, with or without
  actions);
- the turn was interrupted — a question, a plan approval, or the user
  pressing stop — or never reached `agent_result` (a crash has its own
  recovery paths; the agent did not finish a turn, so there is no turn end
  to check);
- the turn was `silent` (compaction) — `silent` is not forwarded into
  `TurnInput` today (`dispatched-turn.ts:307`); this change forwards it;
- the turn was itself a nudge (below);
- a successor is running or queued: the card is checked again when that
  turn ends, and a nudge queued behind a user message would answer the wrong
  turn.

Otherwise it dispatches the nudge through the same entry the queue drain
uses, as a dispatched system turn — not `silent`, so the prompt is echoed as
the turn's user row (`system_user_message`), the agent's reply follows, and
the post-turn flow runs as for any turn. That is the transparency req 12 asks
for. The prompt opens with `[ShipIt]`, the prefix ShipIt already uses for
lines it writes into the conversation (bug-report resolutions), and says: the
last turn ended without a session status update; call `session_status` now
with the two fields; do nothing else.

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
(CLAUDE.md invariant 2), and its first act on any non-`silent` turn without
`statusUpdated` is `markSessionStatusStale`.** That is the second writer of
`fresh`. Only the *dispatch* of a nudge needs `receivedResult` and the other
conditions above; the stale mark does not, because a turn that ended by a
question, a stop or a crash left the card behind just the same.

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
  as the checklist the action card already draws: `ActionChecklistCard`'s
  item list and submit logic (`src/client/components/ActionChecklistCard.tsx`,
  `formatProposalMessage`) are lifted into a shared piece that both the old
  transcript rows and this card use. One "Send" for the ticked items; a
  single action renders as one button, as today. Submitting composes the
  same user message as today and starts a turn; the ticked actions leave the
  offered list at once (they are now a message), the unticked ones stay
  (req 17). Every offered action is shown; the list grows with the offer,
  not with a cap (req 18). The card's `title` and `id` per action are the
  agent's, so an `add` with a known id updates that item in place.

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

## Evolving the action card (req 19)

`propose_actions` is absorbed, not duplicated:

- **Tool.** The `propose_actions` tool stays callable for one release as an
  alias: its call becomes `session_status` with `actions` and no status text,
  which merges the items (req 17) and does **not** set `statusUpdated` — the
  prompt no longer mentions it, so a call is a leftover habit and the nudge
  then asks for the status. Its section in `skeleton.md` is replaced by the
  session-status section.
- **Route.** `api-routes-propose-actions.ts` forwards to the session-status
  service instead of emitting a transcript card. New offers never enter chat
  history.
- **Validation.** `propose-actions-validation.ts` keeps validating the items;
  `session-status-validation.ts` calls it.
- **Renderer.** `ActionChecklistCard` splits into the checklist piece (shared)
  and the transcript-row wrapper (kept for existing `actionChecklist` rows in
  history; nothing is migrated or deleted).
- **Submit path.** `send_message.actionChecklistCardId` keeps marking an old
  transcript card submitted; the pinned card's submit sends the same message
  shape with a `sessionStatusActionIds` list instead, and the route removes
  those ids from the offered list before the turn starts.

## Prompt (req 5)

A short "Session status" section in
`src/server/orchestrator/prompts/skeleton.md`, after "Proposing optional
follow-up actions". It says what the two fields and the action list are, that the status
describes the session and not the turn, that it is the last act of a turn,
that a turn ending in a question needs no update, that "Needs you" is what
only the user can do by hand while an action is agent work approved with a
click (req 20), and that offered actions persist — add to them, or replace
them when they are no longer relevant.
It also says what is **not** a next step: opening, reviewing or merging the
PR is ShipIt's default workflow, never a step to list — the status says
"ready to merge" instead. (Nik, 2026-09-14.)
The tool description carries the same rules in brief, for harnesses whose
system prompt is shorter. Static text, rendered once at module load — the
prompt-cache contract in the `prompt-architecture` skill holds. Tests assert
the section is composed in, not its wording.

## Tests

- `session-status-validation.test.ts` — limits, required fields, trimming,
  action items validated by the shared validator, `replaceActions` semantics
  (merge by id, replace, clear with an empty list).
- `api-routes-session-status.test.ts` — validate → persist → `session_list`
  broadcast → accumulator flag set; 409 when the runner is not active.
- `services/session-status.test.ts` — the decision table: updated /
  interrupted / no result / silent / nudge-itself / successor running → no;
  plain turn → nudge; a `propose_actions` alias call alone → nudge.
- `prepared-dispatch.test.ts` — `statusNudge` survives the queue round trip.
- Integration (`integration_tests/session-status-nudge.test.ts`, FakeClaude):
  a turn without the tool → exactly one dispatched follow-up whose user row
  starts with `[ShipIt]`; the follow-up calls the tool → card persisted and
  fresh; a follow-up that also skips it → no third turn, card marked stale; a
  turn that asks a question → no follow-up; a turn with a queued successor →
  no follow-up until the successor ends; the streaming `agent_result` + `done`
  pair → one decision, not two.
- `SessionStatusCard.test.tsx` — two rows, hidden `Needs you` when empty,
  the "Stale" label present only in the stale state, every offered action
  rendered, submit composes the same message as the transcript card and
  removes the ticked ids.
- `api-routes-propose-actions.test.ts` — the alias merges actions into the
  status and emits no transcript card.
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
- `src/server/orchestrator/api-routes-propose-actions.ts` — the alias; forwards to the session-status service.
- `src/client/components/ActionChecklistCard.tsx` — split into the shared checklist piece and the transcript-row wrapper.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts`, `src/server/shared/types/domain-types/session.ts` — column and type.
- `src/server/shared/session-status-validation.ts` — limits.
- `src/server/orchestrator/prompts/skeleton.md` — the instruction.
- `src/client/components/SessionStatusCard.tsx`, `src/client/App.tsx` — the element.
